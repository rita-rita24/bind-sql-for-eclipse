import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { format } from 'prettier';

export async function formatHtml(html) {
  const embedded = [];
  const template = html.replace(
    /<script\b[^>]*type="(?:text\/plain|application\/octet-stream)"[^>]*>[\s\S]*?<\/script>/g,
    block => {
      const index = embedded.push(block) - 1;
      return `<!-- BINDSQL_EMBEDDED_${index} -->`;
    }
  );
  const formatted = await format(template, {
    parser: 'html',
    tabWidth: 2,
    printWidth: 100,
    trailingComma: 'none'
  });
  return formatted.replace(
    /^([ \t]*)<!-- BINDSQL_EMBEDDED_(\d+) -->/gm,
    (_, indent, index) => {
      const block = embedded[Number(index)];
      return indent + block.replace(/\n[ \t]*<\/script>$/, `\n${indent}</script>`);
    }
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = new URL('../bind-sql-for-eclipse-postgresql.html', import.meta.url);
  const input = await readFile(target, 'utf8');
  const output = await formatHtml(input);
  if (process.argv.includes('--check')) {
    if (input !== output) throw new Error('HTML formatting is stale; run npm run format');
    console.log('HTML formatting is consistent.');
  } else {
    await writeFile(target, output);
  }
}
