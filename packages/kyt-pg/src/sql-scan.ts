const TRANSACTION_WORDS = new Set(['BEGIN', 'START', 'COMMIT', 'END', 'ROLLBACK', 'ABORT']);

function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

function skipBlockComment(sql: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    if (sql.startsWith('/*', i)) {
      depth++;
      i += 2;
    } else if (sql.startsWith('*/', i)) {
      depth--;
      i += 2;
      if (depth === 0) return i;
    } else {
      i++;
    }
  }
  return sql.length;
}

function codeOnly(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    let end = i;
    if (sql.startsWith('--', i)) {
      const newline = sql.indexOf('\n', i);
      end = newline === -1 ? sql.length : newline;
    } else if (sql.startsWith('/*', i)) {
      end = skipBlockComment(sql, i);
    } else if (sql[i] === "'" || sql[i] === '"') {
      end = skipQuoted(sql, i, sql[i]!);
    } else if (sql[i] === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        end = close === -1 ? sql.length : close + tag.length;
      }
    }
    if (end > i) {
      out += ' ';
      i = end;
    } else {
      out += sql[i];
      i++;
    }
  }
  return out;
}

export function findTransactionStatement(sql: string): string | undefined {
  for (const statement of codeOnly(sql).split(';')) {
    const words = statement.trim().match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
    const first = words[0]?.toUpperCase();
    if (!first || !TRANSACTION_WORDS.has(first)) continue;
    if (first === 'ROLLBACK' && words[1]?.toUpperCase() === 'TO') continue;
    return first;
  }
  return undefined;
}
