/* Runs only in a worker. The PostgreSQL parser reads SQL; it never executes it. */
(() => {
  let modulePromise;

  // Parser errors use one-based Unicode character positions. AST locations use
  // zero-based UTF-8 byte offsets. Convert both to textarea's UTF-16 offsets.
  function characterOffset(sql, position) {
    return position > 0 ? [...sql].slice(0, position - 1).join('').length : null;
  }

  function byteOffset(sql, location) {
    if (!Number.isInteger(location) || location < 0) return null;
    let bytes = 0;
    let offset = 0;
    for (const character of sql) {
      if (bytes >= location) break;
      const code = character.codePointAt(0);
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
      offset += character.length;
    }
    return offset;
  }

  function firstLocation(node) {
    const pending = [node];
    let first = null;
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object') continue;
      if (Number.isInteger(value.location) && value.location >= 0) {
        first = first === null ? value.location : Math.min(first, value.location);
      }
      pending.push(...Object.values(value).filter(child => child && typeof child === 'object'));
    }
    return first;
  }

  // A top-level wildcard expands to a catalog-dependent number of columns.
  // count(*) and a scalar subquery containing * each still produce one column.
  function expandsColumns(expression) {
    return !!(expression?.ColumnRef?.fields?.some(field => field.A_Star) ||
      expression?.A_Indirection?.indirection?.some(field => field.A_Star));
  }

  function expressionCount(expressions) {
    return expressions.some(expandsColumns) ? null : expressions.length;
  }

  function checkStructure(tree, sql) {
    const issues = [];
    const counts = new WeakMap();
    const add = (code, message, node) => issues.push({
      code, message, offset: byteOffset(sql, firstLocation(node))
    });

    function countSelect(select) {
      if (!select) return null;
      if (counts.has(select)) return counts.get(select);
      let count = null;
      if (select.valuesLists) {
        const rows = select.valuesLists.map(row => row.List?.items ?? []);
        const rowCounts = rows.map(expressionCount);
        const reference = rowCounts.find(value => value !== null);
        rows.forEach((row, index) => {
          if (rowCounts[index] !== null && reference !== undefined && rowCounts[index] !== reference) {
            add('values-count', `VALUESの${index + 1}行目は値が${rowCounts[index]}個です。他の行（${reference}個）と一致しません。`, row);
          }
        });
        if (rowCounts.length && rowCounts.every(value => value !== null && value === reference)) count = reference;
      } else if (select.op && select.op !== 'SETOP_NONE') {
        const left = countSelect(select.larg);
        const right = countSelect(select.rarg);
        if (left !== null && right !== null && left !== right) {
          const operation = select.op.replace('SETOP_', '');
          add('set-count', `${operation}の左右の列数が一致しません（左${left}列・右${right}列）。`, select.rarg);
        } else if (left !== null && left === right) count = left;
      } else {
        // PostgreSQL also permits a SELECT with an empty target list.
        count = expressionCount((select.targetList ?? []).map(target => target.ResTarget?.val));
      }
      counts.set(select, count);
      return count;
    }

    function checkInsert(insert) {
      const columns = insert.cols ?? [];
      const names = new Map();
      for (const column of columns) {
        const target = column.ResTarget;
        if (!target) continue;
        const previous = names.get(target.name);
        // Separate assignments to fields/array elements of the same column are
        // legal. A whole-column assignment combined with any other is not.
        if (previous && (!previous.indirection?.length || !target.indirection?.length)) {
          add('insert-duplicate-column', `INSERTの列「${target.name}」が重複しています。`, column);
        }
        if (!previous || !target.indirection?.length) names.set(target.name, target);
      }
      const select = insert.selectStmt?.SelectStmt;
      if (!columns.length || !select) return;
      if (select.valuesLists) {
        select.valuesLists.forEach((row, index) => {
          const items = row.List?.items ?? [];
          const count = expressionCount(items);
          if (count !== null && count !== columns.length) {
            add('insert-count', `INSERTの指定列は${columns.length}列ですが、VALUESの${index + 1}行目は値が${count}個です（${Math.abs(columns.length - count)}個${count < columns.length ? '不足' : '超過'}）。`, items);
          }
        });
      } else {
        const count = countSelect(select);
        if (count !== null && count !== columns.length) {
          add('insert-select-count', `INSERTの指定列は${columns.length}列ですが、SELECTの出力は${count}列です。`, select);
        }
      }
    }

    const pending = [tree];
    while (pending.length) {
      const node = pending.pop();
      if (!node || typeof node !== 'object') continue;
      if (node.InsertStmt) checkInsert(node.InsertStmt);
      if (node.SelectStmt) countSelect(node.SelectStmt);
      // UPDATE's row assignment and INSERT ... ON CONFLICT share this node.
      const assignment = node.MultiAssignRef;
      if (assignment?.colno === 1) {
        const source = assignment.source;
        let count = null;
        if (source?.RowExpr) count = expressionCount(source.RowExpr.args ?? []);
        if (source?.SubLink?.subselect?.SelectStmt) count = countSelect(source.SubLink.subselect.SelectStmt);
        if (count !== null && count !== assignment.ncolumns) {
          add('assignment-count', `SETの代入先は${assignment.ncolumns}列ですが、代入する値は${count}個です。`, source);
        }
      }
      pending.push(...Object.values(node).filter(child => child && typeof child === 'object').reverse());
    }
    // MultiAssignRef repeats its source tree once per assigned column.
    const unique = new Map(issues.map(issue => [JSON.stringify(issue), issue]));
    return [...unique.values()].sort((a, b) => (a.offset ?? Infinity) - (b.offset ?? Infinity));
  }

  function parse(module, sql) {
    const size = module.lengthBytesUTF8(sql) + 1;
    const queryPointer = module._malloc(size);
    if (!queryPointer) throw new Error('Could not allocate query');
    let resultPointer = 0;
    try {
      module.stringToUTF8(sql, queryPointer, size);
      resultPointer = module._wasm_parse_query_raw(queryPointer);
      if (!resultPointer) throw new Error('Could not allocate parse result');
      // libpg_query 15: {parse_tree, stderr_buffer, error}, each a wasm32 pointer.
      const errorPointer = module.getValue(resultPointer + 8, 'i32');
      if (errorPointer) {
        return { issues: [{
          code: 'syntax',
          message: module.UTF8ToString(module.getValue(errorPointer, 'i32')),
          offset: characterOffset(sql, module.getValue(errorPointer + 16, 'i32'))
        }] };
      }
      const treePointer = module.getValue(resultPointer, 'i32');
      if (!treePointer) throw new Error('Missing parse tree');
      return { tree: JSON.parse(module.UTF8ToString(treePointer)) };
    } finally {
      if (resultPointer) module._wasm_free_parse_result(resultPointer);
      module._free(queryPointer);
    }
  }

  self.onmessage = async ({ data: { id, sql, wasmBinary } }) => {
    try {
      // The binary is transferred only once, including when the first input
      // contains NUL or has no SQL. Retain initialization for subsequent edits.
      modulePromise ??= PgQueryModule({ wasmBinary });
      const module = await modulePromise;
      if (!sql.trim()) {
        self.postMessage({ id, status: 'empty', issues: [] });
        return;
      }
      const nul = sql.indexOf('\0');
      if (nul >= 0) {
        self.postMessage({ id, status: 'error', issues: [{ code: 'syntax', message: 'SQLにNUL文字が含まれています。', offset: nul }] });
        return;
      }
      const result = parse(module, sql);
      if (result.tree && Math.floor(result.tree.version / 10000) !== 15) throw new Error('Unexpected parser version');
      const issues = result.issues ?? checkStructure(result.tree, sql);
      self.postMessage({
        id,
        status: issues.length ? 'error' : result.tree.stmts?.length ? 'checked' : 'empty',
        issues
      });
    } catch (_error) {
      // Runtime/initialization failures must never be presented as valid SQL.
      self.postMessage({ id, status: 'unavailable', issues: [] });
    }
  };
})();
