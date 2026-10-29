/* pyrun.js: piccolo interprete Python (sottoinsieme) per il libro "Informatica in Classe".
   Nessuna dipendenza esterna. Funziona nella pagina, in un Web Worker e in Node. */
(function (root) {
'use strict';

/* ===================== ERRORI DI SINTASSI ===================== */
class PySyntaxError extends Error {
  constructor(type, msg, line) { super(msg); this.pyType = type; this.msg = msg; this.line = line || 0; }
}

/* ===================== LESSICO ===================== */
const KEYWORDS = new Set(['False','None','True','and','as','assert','break','class','continue','def','del','elif','else','except','finally','for','from','global','if','import','in','is','lambda','nonlocal','not','or','pass','raise','return','try','while','with','yield']);
const OPS = ['**=','//=','>>=','<<=','...','->','==','!=','<=','>=','+=','-=','*=','/=','%=','&=','|=','^=','**','//','<<','>>','+','-','*','/','%','@','&','|','^','~','<','>','(',')','[',']','{','}',',',':','.',';','='];
const STR_PREFIX = new Set(['', 'r', 'f', 'b', 'u', 'rf', 'fr', 'br', 'rb']);

function unescapePy(s) {
  return s.replace(/\\(\n|[\\'"abfnrtv]|x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3})/g, (m, c) => {
    switch (c[0]) {
      case '\n': return '';
      case '\\': return '\\';
      case "'": return "'";
      case '"': return '"';
      case 'a': return '\x07';
      case 'b': return '\b';
      case 'f': return '\f';
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case 'v': return '\v';
      case 'x': case 'u': return String.fromCharCode(parseInt(c.slice(1), 16));
      case 'U': return String.fromCodePoint(parseInt(c.slice(1), 16));
      default: return String.fromCharCode(parseInt(c, 8));
    }
  });
}

function tokenize(src, baseLine) {
  src = src.replace(/\r\n?/g, '\n');
  if (!src.endsWith('\n')) src += '\n';
  const toks = [];
  const n = src.length;
  let i = 0, line = baseLine || 1, depth = 0, atStart = true;
  const indents = [0];
  const push = (t, v) => { const k = { t, v, line }; toks.push(k); return k; };
  const numRe = /0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?/y;
  const nameRe = /[\p{L}_][\p{L}\p{N}_]*/uy;
  const strRe = /([A-Za-z]{0,2})('''|"""|'|")/y;
  while (i < n) {
    if (atStart && depth === 0) {
      let col = 0, j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) { col += src[j] === '\t' ? 8 - (col % 8) : 1; j++; }
      if (j >= n) break;
      if (src[j] === '\n') { i = j + 1; line++; continue; }
      if (src[j] === '#') { while (j < n && src[j] !== '\n') j++; i = j + 1; line++; continue; }
      if (col > indents[indents.length - 1]) { indents.push(col); push('INDENT'); }
      else {
        while (col < indents[indents.length - 1]) { indents.pop(); push('DEDENT'); }
        if (col !== indents[indents.length - 1]) throw new PySyntaxError('IndentationError', 'unindent does not match any outer indentation level', line);
      }
      i = j; atStart = false;
    }
    const c = src[i];
    if (c === '\n') {
      i++;
      if (depth > 0) { line++; continue; }
      push('NEWLINE'); line++; atStart = true; continue;
    }
    if (c === ' ' || c === '\t' || c === '\f') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; line++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    // stringhe
    strRe.lastIndex = i;
    let m = strRe.exec(src);
    if (m && STR_PREFIX.has(m[1].toLowerCase())) {
      const prefix = m[1].toLowerCase(), quote = m[2], triple = quote.length === 3;
      const raw = prefix.indexOf('r') >= 0, isF = prefix.indexOf('f') >= 0;
      let j = i + m[0].length, body = '';
      const startLine = line;
      for (;;) {
        if (j >= n) throw new PySyntaxError('SyntaxError', 'unterminated string literal (detected at line ' + line + ')', startLine);
        const ch = src[j];
        if (!triple && ch === '\n') throw new PySyntaxError('SyntaxError', 'unterminated string literal (detected at line ' + line + ')', startLine);
        if (src.startsWith(quote, j)) { j += quote.length; break; }
        if (ch === '\\') { body += ch + (src[j + 1] || ''); if (src[j + 1] === '\n') line++; j += 2; continue; }
        if (ch === '\n') line++;
        body += ch; j++;
      }
      if (isF) push('FSTR', body).raw = raw;
      else push('STR', raw ? body : unescapePy(body));
      i = j; continue;
    }
    // numeri
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      numRe.lastIndex = i;
      m = numRe.exec(src);
      const text = m[0].replace(/_/g, '');
      const isHex = /^0[xXoObB]/.test(text);
      if (!isHex && /[.eE]/.test(text)) push('NUM', Number(text));
      else {
        if (!isHex && text.length > 1 && text[0] === '0' && /[1-9]/.test(text)) throw new PySyntaxError('SyntaxError', 'leading zeros in decimal integer literals are not permitted; use an 0o prefix for octal integers', line);
        push('NUM', BigInt(text));
      }
      i += m[0].length;
      if (i < n && /[\p{L}_]/u.test(src[i])) throw new PySyntaxError('SyntaxError', 'invalid decimal literal', line);
      continue;
    }
    // nomi
    nameRe.lastIndex = i;
    m = nameRe.exec(src);
    if (m) { push('NAME', m[0]); i += m[0].length; continue; }
    // operatori
    let op = null;
    for (const o of OPS) if (src.startsWith(o, i)) { op = o; break; }
    if (!op) throw new PySyntaxError('SyntaxError', "invalid character '" + c + "'", line);
    if (op === '(' || op === '[' || op === '{') depth++;
    else if (op === ')' || op === ']' || op === '}') { depth--; if (depth < 0) throw new PySyntaxError('SyntaxError', "unmatched '" + op + "'", line); }
    push('OP', op); i += op.length;
  }
  if (depth > 0) throw new PySyntaxError('SyntaxError', "'(' was never closed", line);
  const last = toks[toks.length - 1];
  if (last && last.t !== 'NEWLINE' && last.t !== 'DEDENT' && last.t !== 'INDENT') push('NEWLINE');
  while (indents.length > 1) { indents.pop(); push('DEDENT'); }
  push('EOF');
  return toks;
}

/* ===================== PARSER ===================== */
const AUG_OPS = ['+=','-=','*=','/=','//=','%=','**=','&=','|=','^=','<<=','>>='];

class Parser {
  constructor(toks) { this.t = toks; this.i = 0; }
  get tok() { return this.t[this.i]; }
  peek(k) { return this.t[Math.min(this.i + (k || 0), this.t.length - 1)]; }
  next() { return this.t[this.i++]; }
  isOp(v) { const k = this.tok; return k.t === 'OP' && k.v === v; }
  isKw(v) { const k = this.tok; return k.t === 'NAME' && k.v === v; }
  acceptOp(v) { if (this.isOp(v)) { this.i++; return true; } return false; }
  acceptKw(v) { if (this.isKw(v)) { this.i++; return true; } return false; }
  err(msg) { throw new PySyntaxError('SyntaxError', msg || 'invalid syntax', this.tok.line); }
  expectOp(v, msg) { if (!this.acceptOp(v)) this.err(msg || "expected '" + v + "'"); }
  expectKw(v) { if (!this.acceptKw(v)) this.err("expected '" + v + "'"); }
  name() {
    const k = this.tok;
    if (k.t !== 'NAME' || KEYWORDS.has(k.v)) this.err();
    this.i++; return k.v;
  }

  parseFile() {
    const body = [];
    while (this.tok.t !== 'EOF') {
      if (this.tok.t === 'NEWLINE') { this.i++; continue; }
      body.push(...this.statement());
    }
    return body;
  }

  statement() {
    const k = this.tok;
    if (k.t === 'INDENT') throw new PySyntaxError('IndentationError', 'unexpected indent', k.line);
    if (k.t === 'DEDENT') this.err();
    if (k.t === 'NAME') {
      switch (k.v) {
        case 'if': return [this.ifStmt()];
        case 'while': return [this.whileStmt()];
        case 'for': return [this.forStmt()];
        case 'def': return [this.funcDef([])];
        case 'class': return [this.classDef([])];
        case 'try': return [this.tryStmt()];
        case 'with': this.err("l'istruzione 'with' non è supportata in questo editor");
        case 'async': this.err('async non è supportato in questo editor');
      }
    }
    if (k.t === 'OP' && k.v === '@') return [this.decorated()];
    return this.simpleLine();
  }

  simpleLine() {
    const out = [this.simple()];
    while (this.acceptOp(';')) {
      if (this.tok.t === 'NEWLINE' || this.tok.t === 'EOF') break;
      out.push(this.simple());
    }
    if (this.tok.t === 'NEWLINE') this.i++;
    else if (this.tok.t !== 'EOF') this.err();
    return out;
  }

  block(what, line) {
    if (this.tok.t === 'NEWLINE') {
      this.i++;
      if (this.tok.t !== 'INDENT') throw new PySyntaxError('IndentationError', 'expected an indented block after ' + what + ' on line ' + line, this.tok.line);
      this.i++;
      const body = [];
      while (this.tok.t !== 'DEDENT' && this.tok.t !== 'EOF') {
        if (this.tok.t === 'NEWLINE') { this.i++; continue; }
        body.push(...this.statement());
      }
      if (this.tok.t === 'DEDENT') this.i++;
      return body;
    }
    if (this.tok.t === 'EOF') throw new PySyntaxError('IndentationError', 'expected an indented block after ' + what + ' on line ' + line, this.tok.line);
    return this.simpleLine();
  }

  noAssignHere() {
    if (this.isOp('=')) this.err("invalid syntax. Maybe you meant '==' or ':=' instead of '='?");
  }

  ifStmt() {
    const line = this.next().line;
    const test = this.test();
    this.noAssignHere();
    this.expectOp(':');
    const body = this.block("'if' statement", line);
    let orelse = [];
    if (this.isKw('elif')) { this.tok.v = 'if'; orelse = [this.ifStmt()]; }
    else if (this.isKw('else')) { const l = this.next().line; this.expectOp(':'); orelse = this.block("'else' statement", l); }
    return { k: 'If', test, body, orelse, line };
  }
  whileStmt() {
    const line = this.next().line;
    const test = this.test();
    this.noAssignHere();
    this.expectOp(':');
    const body = this.block("'while' statement", line);
    let orelse = [];
    if (this.isKw('else')) { const l = this.next().line; this.expectOp(':'); orelse = this.block("'else' statement", l); }
    return { k: 'While', test, body, orelse, line };
  }
  forStmt() {
    const line = this.next().line;
    const target = this.targetList();
    this.checkTarget(target);
    this.expectKw('in');
    const iter = this.testList();
    this.expectOp(':');
    const body = this.block("'for' statement", line);
    let orelse = [];
    if (this.isKw('else')) { const l = this.next().line; this.expectOp(':'); orelse = this.block("'else' statement", l); }
    return { k: 'For', target, iter, body, orelse, line };
  }
  tryStmt() {
    const line = this.next().line;
    this.expectOp(':');
    const body = this.block("'try' statement", line);
    const handlers = [];
    let orelse = [], finalbody = [];
    while (this.isKw('except')) {
      const l = this.next().line;
      let type = null, name = null;
      if (!this.isOp(':')) { type = this.test(); if (this.acceptKw('as')) name = this.name(); }
      this.expectOp(':');
      handlers.push({ type, name, body: this.block("'except' statement", l), line: l });
    }
    if (handlers.length && this.isKw('else')) { const l = this.next().line; this.expectOp(':'); orelse = this.block("'else' statement", l); }
    if (this.isKw('finally')) { const l = this.next().line; this.expectOp(':'); finalbody = this.block("'finally' statement", l); }
    if (!handlers.length && !finalbody.length) throw new PySyntaxError('SyntaxError', "expected 'except' or 'finally' block", this.tok.line);
    return { k: 'Try', body, handlers, orelse, finalbody, line };
  }
  decorated() {
    const decorators = [];
    while (this.isOp('@')) {
      this.i++;
      decorators.push(this.test());
      if (this.tok.t !== 'NEWLINE') this.err();
      this.i++;
    }
    if (this.isKw('def')) return this.funcDef(decorators);
    if (this.isKw('class')) return this.classDef(decorators);
    this.err();
  }
  params(end) {
    const ps = [];
    let seenStar = false;
    while (!this.isOp(end)) {
      if (this.acceptOp('**')) ps.push({ name: this.name(), kind: 'kwarg', default: null });
      else if (this.acceptOp('*')) {
        if (this.isOp(',')) seenStar = true;
        else { ps.push({ name: this.name(), kind: 'vararg', default: null }); seenStar = true; }
      } else {
        const nm = this.name();
        let def = null;
        if (end === ')' && this.acceptOp(':')) this.test();
        if (this.acceptOp('=')) def = this.test();
        ps.push({ name: nm, default: def, kind: seenStar ? 'kwonly' : 'pos' });
      }
      if (!this.acceptOp(',')) break;
    }
    return ps;
  }
  funcDef(decorators) {
    const line = this.next().line;
    const name = this.name();
    this.expectOp('(');
    const params = this.params(')');
    this.expectOp(')');
    if (this.acceptOp('->')) this.test();
    this.expectOp(':');
    const body = this.block('function definition', line);
    return { k: 'FuncDef', name, params, body, decorators, line };
  }
  classDef(decorators) {
    const line = this.next().line;
    const name = this.name();
    const bases = [];
    if (this.acceptOp('(')) {
      while (!this.isOp(')')) { bases.push(this.test()); if (!this.acceptOp(',')) break; }
      this.expectOp(')');
    }
    this.expectOp(':');
    const body = this.block('class definition', line);
    return { k: 'ClassDef', name, bases, body, decorators, line };
  }

  endOfSimple() { const k = this.tok; return k.t === 'NEWLINE' || k.t === 'EOF' || (k.t === 'OP' && k.v === ';'); }

  simple() {
    const k = this.tok, line = k.line;
    if (k.t === 'NAME') {
      switch (k.v) {
        case 'pass': this.i++; return { k: 'Pass', line };
        case 'break': this.i++; return { k: 'Break', line };
        case 'continue': this.i++; return { k: 'Continue', line };
        case 'return': { this.i++; let e = null; if (!this.endOfSimple()) e = this.testList(); return { k: 'Return', e, line }; }
        case 'global': case 'nonlocal': {
          this.i++;
          const names = [this.name()];
          while (this.acceptOp(',')) names.push(this.name());
          return { k: k.v === 'global' ? 'Global' : 'Nonlocal', names, line };
        }
        case 'import': return this.importStmt();
        case 'from': return this.fromStmt();
        case 'raise': {
          this.i++;
          let e = null;
          if (!this.endOfSimple()) { e = this.test(); if (this.acceptKw('from')) this.test(); }
          return { k: 'Raise', e, line };
        }
        case 'assert': {
          this.i++;
          const test = this.test();
          let msg = null;
          if (this.acceptOp(',')) msg = this.test();
          return { k: 'Assert', test, msg, line };
        }
        case 'del': {
          this.i++;
          const targets = [this.bitOr()];
          while (this.acceptOp(',')) targets.push(this.bitOr());
          return { k: 'Del', targets, line };
        }
        case 'yield': this.err("'yield' (generatori) non è supportato in questo editor");
        case 'else': case 'elif': case 'except': case 'finally': this.err();
      }
    }
    return this.exprStmt();
  }

  dottedName() {
    let nm = this.name();
    while (this.acceptOp('.')) nm += '.' + this.name();
    return nm;
  }
  importStmt() {
    const line = this.next().line;
    const names = [];
    do {
      const name = this.dottedName();
      let asname = null;
      if (this.acceptKw('as')) asname = this.name();
      names.push({ name, asname });
    } while (this.acceptOp(','));
    return { k: 'Import', names, line };
  }
  fromStmt() {
    const line = this.next().line;
    const mod = this.dottedName();
    this.expectKw('import');
    if (this.acceptOp('*')) return { k: 'ImportFrom', mod, names: '*', line };
    const paren = this.acceptOp('(');
    const names = [];
    do {
      if (paren && this.isOp(')')) break;
      const name = this.name();
      let asname = null;
      if (this.acceptKw('as')) asname = this.name();
      names.push({ name, asname });
    } while (this.acceptOp(','));
    if (paren) this.expectOp(')');
    return { k: 'ImportFrom', mod, names, line };
  }

  checkTarget(t, aug) {
    switch (t.k) {
      case 'Name': case 'Attr': case 'Sub': return;
      case 'Tuple': case 'List':
        if (aug) break;
        t.elts.forEach(e => e.k === 'Star' ? this.checkTarget(e.e) : this.checkTarget(e));
        return;
    }
    const what = { Const: 'literal', Call: 'function call', BinOp: 'expression', Compare: 'comparison', BoolOp: 'expression', UnaryOp: 'expression' }[t.k] || 'expression';
    throw new PySyntaxError('SyntaxError', 'cannot assign to ' + what, t.line || this.tok.line);
  }

  exprStmt() {
    const line = this.tok.line;
    const first = this.testList();
    if (this.isOp('=')) {
      const targets = [first];
      let value;
      while (this.acceptOp('=')) {
        value = this.testList();
        if (this.isOp('=')) targets.push(value);
      }
      targets.forEach(t => this.checkTarget(t));
      return { k: 'Assign', targets, value, line };
    }
    if (this.tok.t === 'OP' && AUG_OPS.indexOf(this.tok.v) >= 0) {
      const op = this.next().v.slice(0, -1);
      this.checkTarget(first, true);
      const value = this.testList();
      return { k: 'AugAssign', target: first, op, value, line };
    }
    if (this.isOp(':') && (first.k === 'Name' || first.k === 'Attr')) {
      this.i++;
      this.test();
      if (this.acceptOp('=')) return { k: 'Assign', targets: [first], value: this.testList(), line };
      return { k: 'Pass', line };
    }
    return { k: 'Expr', e: first, line };
  }

  exprEnd() {
    const k = this.tok;
    if (k.t === 'NEWLINE' || k.t === 'EOF') return true;
    if (k.t === 'OP') return [')', ']', '}', '=', ':', ';'].indexOf(k.v) >= 0 || AUG_OPS.indexOf(k.v) >= 0;
    return false;
  }
  testList() {
    const line = this.tok.line;
    const first = this.testOrStar();
    if (!this.isOp(',')) return first;
    const elts = [first];
    while (this.acceptOp(',')) { if (this.exprEnd()) break; elts.push(this.testOrStar()); }
    return { k: 'Tuple', elts, line };
  }
  testOrStar() {
    if (this.isOp('*')) { this.i++; return { k: 'Star', e: this.bitOr() }; }
    return this.test();
  }
  targetList() {
    const line = this.tok.line;
    const first = this.targetItem();
    if (!this.isOp(',')) return first;
    const elts = [first];
    while (this.acceptOp(',')) { if (this.isKw('in') || this.isOp('=')) break; elts.push(this.targetItem()); }
    return { k: 'Tuple', elts, line };
  }
  targetItem() {
    if (this.acceptOp('*')) return { k: 'Star', e: this.bitOr() };
    return this.bitOr();
  }

  test() {
    if (this.isKw('lambda')) return this.lambda();
    const e = this.orTest();
    if (this.isKw('if')) {
      const line = this.next().line;
      const cond = this.orTest();
      this.expectKw('else');
      const other = this.test();
      return { k: 'IfExp', test: cond, body: e, orelse: other, line };
    }
    return e;
  }
  lambda() {
    const line = this.next().line;
    const params = this.params(':');
    this.expectOp(':');
    const body = this.test();
    return { k: 'Lambda', params, body, line };
  }
  orTest() {
    const first = this.andTest();
    if (!this.isKw('or')) return first;
    const vals = [first];
    while (this.acceptKw('or')) vals.push(this.andTest());
    return { k: 'BoolOp', op: 'or', vals, line: first.line };
  }
  andTest() {
    const first = this.notTest();
    if (!this.isKw('and')) return first;
    const vals = [first];
    while (this.acceptKw('and')) vals.push(this.notTest());
    return { k: 'BoolOp', op: 'and', vals, line: first.line };
  }
  notTest() {
    if (this.isKw('not')) { const line = this.next().line; return { k: 'UnaryOp', op: 'not', e: this.notTest(), line }; }
    return this.comparison();
  }
  comparison() {
    const first = this.bitOr();
    const ops = [];
    for (;;) {
      let op = null;
      const k = this.tok;
      if (k.t === 'OP' && ['<', '>', '==', '!=', '<=', '>='].indexOf(k.v) >= 0) { op = k.v; this.i++; }
      else if (k.t === 'NAME') {
        if (k.v === 'in') { op = 'in'; this.i++; }
        else if (k.v === 'not' && this.peek(1).t === 'NAME' && this.peek(1).v === 'in') { op = 'not in'; this.i += 2; }
        else if (k.v === 'is') { this.i++; op = this.acceptKw('not') ? 'is not' : 'is'; }
      }
      if (!op) break;
      ops.push({ op, e: this.bitOr() });
    }
    return ops.length ? { k: 'Compare', first, ops, line: first.line } : first;
  }
  level(sub, ops) {
    let l = sub.call(this);
    while (this.tok.t === 'OP' && ops.indexOf(this.tok.v) >= 0) {
      const t = this.next();
      const r = sub.call(this);
      l = { k: 'BinOp', op: t.v, l, r, line: t.line };
    }
    return l;
  }
  bitOr() { return this.level(this.bitXor, ['|']); }
  bitXor() { return this.level(this.bitAnd, ['^']); }
  bitAnd() { return this.level(this.shift, ['&']); }
  shift() { return this.level(this.arith, ['<<', '>>']); }
  arith() { return this.level(this.term, ['+', '-']); }
  term() { return this.level(this.factor, ['*', '/', '//', '%', '@']); }
  factor() {
    const k = this.tok;
    if (k.t === 'OP' && (k.v === '-' || k.v === '+' || k.v === '~')) {
      this.i++;
      return { k: 'UnaryOp', op: k.v, e: this.factor(), line: k.line };
    }
    return this.power();
  }
  power() {
    const base = this.primary();
    if (this.isOp('**')) {
      const line = this.next().line;
      return { k: 'BinOp', op: '**', l: base, r: this.factor(), line };
    }
    return base;
  }
  primary() {
    let e = this.atom();
    for (;;) {
      const k = this.tok;
      if (k.t !== 'OP') break;
      if (k.v === '(') { this.i++; e = { k: 'Call', func: e, args: this.callArgs(), line: k.line }; }
      else if (k.v === '[') { this.i++; const idx = this.subscript(); this.expectOp(']'); e = { k: 'Sub', obj: e, idx, line: k.line }; }
      else if (k.v === '.') {
        this.i++;
        const nm = this.tok;
        if (nm.t !== 'NAME') this.err();
        this.i++;
        e = { k: 'Attr', obj: e, name: nm.v, line: k.line };
      } else break;
    }
    return e;
  }
  callArgs() {
    const args = [];
    while (!this.isOp(')')) {
      if (this.acceptOp('**')) args.push({ e: this.test(), dstar: true });
      else if (this.acceptOp('*')) args.push({ e: this.test(), star: true });
      else if (this.tok.t === 'NAME' && !KEYWORDS.has(this.tok.v) && this.peek(1).t === 'OP' && this.peek(1).v === '=') {
        const nm = this.next().v; this.i++;
        args.push({ e: this.test(), kw: nm });
      } else {
        const e = this.test();
        if (this.isKw('for')) args.push({ e: { k: 'GenExp', elt: e, gens: this.compFor(), line: e.line } });
        else args.push({ e });
      }
      if (!this.acceptOp(',')) break;
    }
    this.expectOp(')', "'(' was never closed");
    return args;
  }
  subscript() {
    const first = this.sliceItem();
    if (!this.isOp(',')) return first;
    const elts = [first];
    while (this.acceptOp(',')) { if (this.isOp(']')) break; elts.push(this.sliceItem()); }
    return { k: 'Tuple', elts };
  }
  sliceItem() {
    let lo = null, hi = null, step = null;
    if (!this.isOp(':')) { lo = this.test(); if (!this.isOp(':')) return lo; }
    this.expectOp(':');
    if (!this.isOp(':') && !this.isOp(']') && !this.isOp(',')) hi = this.test();
    if (this.acceptOp(':')) { if (!this.isOp(']') && !this.isOp(',')) step = this.test(); }
    return { k: 'Slice', lo, hi, step };
  }
  compFor() {
    const gens = [];
    while (this.isKw('for')) {
      this.i++;
      const target = this.targetList();
      this.expectKw('in');
      const iter = this.orTest();
      const ifs = [];
      while (this.isKw('if')) { this.i++; ifs.push(this.orTest()); }
      gens.push({ target, iter, ifs });
    }
    return gens;
  }

  atom() {
    const k = this.tok, line = k.line;
    if (k.t === 'NUM') { this.i++; return { k: 'Const', v: k.v, line }; }
    if (k.t === 'STR' || k.t === 'FSTR') return this.strings();
    if (k.t === 'NAME') {
      if (k.v === 'True') { this.i++; return { k: 'Const', v: true, line }; }
      if (k.v === 'False') { this.i++; return { k: 'Const', v: false, line }; }
      if (k.v === 'None') { this.i++; return { k: 'Const', v: null, line }; }
      if (KEYWORDS.has(k.v)) this.err();
      this.i++;
      return { k: 'Name', id: k.v, line };
    }
    if (k.t === 'OP') {
      if (k.v === '(') {
        this.i++;
        if (this.acceptOp(')')) return { k: 'Tuple', elts: [], line };
        const first = this.testOrStar();
        if (this.isKw('for')) { const gens = this.compFor(); this.expectOp(')'); return { k: 'GenExp', elt: first, gens, line }; }
        if (this.isOp(',')) {
          const elts = [first];
          while (this.acceptOp(',')) { if (this.isOp(')')) break; elts.push(this.testOrStar()); }
          this.expectOp(')');
          return { k: 'Tuple', elts, line };
        }
        this.expectOp(')', "'(' was never closed");
        if (first.k === 'Star') this.err();
        return first;
      }
      if (k.v === '[') {
        this.i++;
        if (this.acceptOp(']')) return { k: 'List', elts: [], line };
        const first = this.testOrStar();
        if (this.isKw('for')) { const gens = this.compFor(); this.expectOp(']'); return { k: 'ListComp', elt: first, gens, line }; }
        const elts = [first];
        while (this.acceptOp(',')) { if (this.isOp(']')) break; elts.push(this.testOrStar()); }
        this.expectOp(']', "'[' was never closed");
        return { k: 'List', elts, line };
      }
      if (k.v === '{') return this.braces();
      if (k.v === '...') { this.i++; return { k: 'Const', v: null, line }; }
    }
    this.err();
  }
  braces() {
    const line = this.next().line;
    if (this.acceptOp('}')) return { k: 'Dict', keys: [], values: [], line };
    if (this.isOp('**')) return this.dictRest([], [], line);
    const first = this.testOrStar();
    if (this.isOp(':')) {
      this.i++;
      const v = this.test();
      if (this.isKw('for')) { const gens = this.compFor(); this.expectOp('}'); return { k: 'DictComp', key: first, value: v, gens, line }; }
      return this.dictRest([first], [v], line);
    }
    if (this.isKw('for')) { const gens = this.compFor(); this.expectOp('}'); return { k: 'SetComp', elt: first, gens, line }; }
    const elts = [first];
    while (this.acceptOp(',')) { if (this.isOp('}')) break; elts.push(this.testOrStar()); }
    this.expectOp('}', "'{' was never closed");
    return { k: 'Set', elts, line };
  }
  dictRest(keys, values, line) {
    if (keys.length) { if (!this.acceptOp(',')) { this.expectOp('}', "'{' was never closed"); return { k: 'Dict', keys, values, line }; } }
    while (!this.isOp('}')) {
      if (this.acceptOp('**')) { keys.push(null); values.push(this.bitOr()); }
      else { const kk = this.test(); this.expectOp(':'); keys.push(kk); values.push(this.test()); }
      if (!this.acceptOp(',')) break;
    }
    this.expectOp('}', "'{' was never closed");
    return { k: 'Dict', keys, values, line };
  }

  strings() {
    const line = this.tok.line;
    const parts = [];
    let anyF = false;
    while (this.tok.t === 'STR' || this.tok.t === 'FSTR') {
      const t = this.next();
      if (t.t === 'STR') parts.push({ lit: t.v });
      else { anyF = true; parts.push(...parseFString(t.v, !!t.raw, t.line).parts); }
    }
    if (!anyF) return { k: 'Const', v: parts.map(p => p.lit).join(''), line };
    return { k: 'FStr', parts, line };
  }
}

function parseExprString(text, line) {
  const p = new Parser(tokenize('(' + text + ')', line));
  const e = p.testList();
  if (p.tok.t !== 'NEWLINE' && p.tok.t !== 'EOF') p.err('f-string: invalid syntax');
  return e;
}

function parseFString(body, raw, line) {
  const parts = [];
  let lit = '', i = 0;
  const n = body.length;
  const flush = () => { if (lit) { parts.push({ lit: raw ? lit : unescapePy(lit) }); lit = ''; } };
  while (i < n) {
    const c = body[i];
    if (c === '{') {
      if (body[i + 1] === '{') { lit += '{'; i += 2; continue; }
      flush();
      let depth = 0, j = i + 1, inStr = null;
      for (; j < n; j++) {
        const d = body[j];
        if (inStr) { if (d === '\\') j++; else if (d === inStr) inStr = null; continue; }
        if (d === "'" || d === '"') { inStr = d; continue; }
        if (d === '(' || d === '[' || d === '{') depth++;
        else if (d === ')' || d === ']') depth--;
        else if (d === '}') { if (depth === 0) break; depth--; }
        else if (depth === 0 && d === ':') break;
        else if (depth === 0 && d === '!' && body[j + 1] !== '=') break;
      }
      if (j >= n) throw new PySyntaxError('SyntaxError', "f-string: expecting '}'", line);
      let exprText = body.slice(i + 1, j);
      let debug = false;
      const dm = /^([\s\S]*[^=!<>])=\s*$/.exec(exprText);
      if (dm) { debug = exprText; exprText = dm[1]; }
      let conv = null, spec = null;
      if (body[j] === '!') { conv = body[j + 1]; j += 2; }
      if (body[j] === ':') {
        let d2 = 0, k = j + 1;
        for (; k < n; k++) { if (body[k] === '{') d2++; else if (body[k] === '}') { if (d2 === 0) break; d2--; } }
        spec = parseFString(body.slice(j + 1, k), true, line);
        j = k;
      }
      if (body[j] !== '}') throw new PySyntaxError('SyntaxError', "f-string: expecting '}'", line);
      if (!exprText.trim()) throw new PySyntaxError('SyntaxError', 'f-string: empty expression not allowed', line);
      if (debug) parts.push({ lit: debug });
      parts.push({ expr: parseExprString(exprText, line), conv: conv || (debug && !spec ? 'r' : null), spec });
      i = j + 1; continue;
    }
    if (c === '}') {
      if (body[i + 1] === '}') { lit += '}'; i += 2; continue; }
      throw new PySyntaxError('SyntaxError', "f-string: single '}' is not allowed", line);
    }
    lit += c; i++;
  }
  flush();
  return { k: 'FStr', parts };
}

function parseProgram(src) {
  return new Parser(tokenize(src)).parseFile();
}

/* ===================== VALORI ===================== */
let ctx = null;
const DONE = Symbol('DONE');
class PyTuple { constructor(a) { this.a = a; } }
class PyDict { constructor() { this.m = new Map(); } }
class PySet { constructor() { this.m = new Map(); } }
class PyRange { constructor(start, stop, step) { this.start = start; this.stop = stop; this.step = step; } }
class PyIter { constructor(nx, kind) { this.nx = nx; this.kind = kind || 'iterator'; } }
class PyView { constructor(d, kind) { this.d = d; this.kind = kind; } }
class PySlice { constructor(lo, hi, step) { this.lo = lo; this.hi = hi; this.step = step; } }
class PyFunction {
  constructor(name, params, defaults, body, closure, isLambda) {
    this.name = name; this.params = params; this.defaults = defaults; this.body = body;
    this.closure = closure; this.isLambda = isLambda; this.home = null;
  }
}
class PyBuiltin { constructor(name, fn, tname) { this.name = name; this.fn = fn; this.tname = tname || null; } }
class PyClass { constructor(name, bases, d) { this.name = name; this.bases = bases; this.d = d; this.mro = null; } }
class PyObj { constructor(cls) { this.cls = cls; this.d = new Map(); } }
class PyBound { constructor(fn, self) { this.fn = fn; this.self = self; } }
class PyModule { constructor(name, d) { this.name = name; this.d = d; } }
class PyProperty { constructor(g, s) { this.fget = g; this.fset = s; } }
class PyStatic { constructor(f) { this.f = f; } }
class PyClassMethod { constructor(f) { this.f = f; } }
class PySuper { constructor(cls, obj) { this.cls = cls; this.obj = obj; } }
class PyThrow extends Error { constructor(obj) { super('PyThrow'); this.obj = obj; this.line = ctx ? ctx.line : 0; } }
class PyAbort extends Error { constructor(kind, msg) { super(msg || kind); this.kind = kind; } }

/* ===================== CLASSI ED ECCEZIONI ===================== */
function computeMRO(cls) {
  const seqs = cls.bases.map(b => b.mro.slice());
  seqs.push(cls.bases.slice());
  const res = [cls];
  for (;;) {
    const ne = seqs.filter(s => s.length);
    if (!ne.length) return res;
    let cand = null;
    for (const s of ne) { const c = s[0]; if (!ne.some(t => t.indexOf(c) > 0)) { cand = c; break; } }
    if (!cand) raise('TypeError', 'Cannot create a consistent method resolution order (MRO)');
    res.push(cand);
    for (const s of seqs) if (s[0] === cand) s.shift();
  }
}
function mkClass(name, bases, d) { const c = new PyClass(name, bases, d || new Map()); c.mro = computeMRO(c); return c; }
const C_object = mkClass('object', []);
const EXC = {};
function defExc(name, base) { EXC[name] = mkClass(name, [base]); return EXC[name]; }
EXC.BaseException = mkClass('BaseException', [C_object]);
EXC.BaseException.d.set('__init__', new PyBuiltin('__init__', a => { a[0].d.set('args', new PyTuple(a.slice(1))); return null; }));
defExc('Exception', EXC.BaseException);
[['ArithmeticError', 'Exception'], ['LookupError', 'Exception'], ['ValueError', 'Exception'], ['TypeError', 'Exception'],
 ['NameError', 'Exception'], ['AttributeError', 'Exception'], ['RuntimeError', 'Exception'], ['AssertionError', 'Exception'],
 ['StopIteration', 'Exception'], ['EOFError', 'Exception'], ['ImportError', 'Exception'], ['OSError', 'Exception'],
 ['ZeroDivisionError', 'ArithmeticError'], ['OverflowError', 'ArithmeticError'], ['IndexError', 'LookupError'], ['KeyError', 'LookupError'],
 ['RecursionError', 'RuntimeError'], ['NotImplementedError', 'RuntimeError'], ['ModuleNotFoundError', 'ImportError'],
 ['FileNotFoundError', 'OSError'], ['StatisticsError', 'ValueError']
].forEach(p => defExc(p[0], EXC[p[1]]));

function makeExc(type, msg) {
  const o = new PyObj(EXC[type]);
  o.d.set('args', new PyTuple(msg === undefined ? [] : [msg]));
  return o;
}
function raise(type, msg) { throw new PyThrow(makeExc(type, msg)); }
function isExc(o) { return o instanceof PyObj && o.cls.mro.indexOf(EXC.BaseException) >= 0; }
function isSubclass(c, base) { return c.mro.indexOf(base) >= 0; }
function findAttr(cls, name) {
  const mro = cls.mro;
  for (let i = 0; i < mro.length; i++) { const v = mro[i].d.get(name); if (v !== undefined) return v; }
  return undefined;
}

/* ===================== UTILITA' NUMERICHE ===================== */
const isInt = v => typeof v === 'bigint' || typeof v === 'boolean';
const isNum = v => typeof v === 'bigint' || typeof v === 'number' || typeof v === 'boolean';
const toBig = v => typeof v === 'boolean' ? (v ? 1n : 0n) : v;
const toF = v => typeof v === 'bigint' ? Number(v) : typeof v === 'boolean' ? (v ? 1 : 0) : v;

function floatParts(x) {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, Math.abs(x));
  const hi = dv.getUint32(0), lo = dv.getUint32(4);
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (exp === 0) return [mant, -1074];
  mant |= (1n << 52n);
  return [mant, exp - 1075];
}
function fixedRound(x, prec) {
  const neg = x < 0 || Object.is(x, -0);
  const [m, e] = floatParts(x);
  const p10 = 10n ** BigInt(prec);
  let scaled;
  if (e >= 0) scaled = (m << BigInt(e)) * p10;
  else {
    const num = m * p10, den = 1n << BigInt(-e);
    let q = num / den;
    const twice = (num % den) * 2n;
    if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
    scaled = q;
  }
  let s = scaled.toString();
  if (prec > 0) { s = s.padStart(prec + 1, '0'); s = s.slice(0, -prec) + '.' + s.slice(-prec); }
  return (neg ? '-' : '') + s;
}
function fmtFloat(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const m = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(x.toExponential());
  const sign = m[1], digits = m[2] + (m[3] || ''), exp = parseInt(m[4], 10);
  if (exp >= -4 && exp < 16) {
    if (exp >= 0) {
      if (digits.length <= exp + 1) return sign + digits + '0'.repeat(exp + 1 - digits.length) + '.0';
      return sign + digits.slice(0, exp + 1) + '.' + digits.slice(exp + 1);
    }
    return sign + '0.' + '0'.repeat(-exp - 1) + digits;
  }
  const mant = digits.length > 1 ? digits[0] + '.' + digits.slice(1) : digits[0];
  return sign + mant + 'e' + (exp < 0 ? '-' : '+') + String(Math.abs(exp)).padStart(2, '0');
}
function expFormat(x, prec, upper) {
  let s = x.toExponential(prec).replace(/e([+-])(\d)$/, 'e$10$2');
  return upper ? s.toUpperCase() : s;
}
function genFormat(x, prec, alt, upper) {
  if (prec === null) prec = 6;
  if (prec === 0) prec = 1;
  let s;
  if (x === 0) { s = alt && prec > 1 ? '0.' + '0'.repeat(prec - 1) : '0'; }
  else {
    const e = parseInt(x.toExponential(prec - 1).split('e')[1], 10);
    if (e >= -4 && e < prec) {
      s = fixedRound(x, prec - 1 - e);
      if (!alt && s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, '');
    } else {
      s = expFormat(x, prec - 1, false);
      if (!alt) s = s.replace(/\.?0+e/, 'e');
    }
  }
  return upper ? s.toUpperCase() : s;
}
function roundHalfEvenInt(x) {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}
function pyRound(x, nd) {
  if (nd === undefined || nd === null) {
    if (typeof x === 'number') {
      if (!isFinite(x)) raise(Number.isNaN(x) ? 'ValueError' : 'OverflowError', Number.isNaN(x) ? 'cannot convert float NaN to integer' : 'cannot convert float infinity to integer');
      return BigInt(roundHalfEvenInt(x));
    }
    return toBig(x);
  }
  const n = Number(toBig(nd));
  if (isInt(x)) {
    if (n >= 0) return toBig(x);
    const p = 10n ** BigInt(-n), v = toBig(x);
    let q = v / p, r = v % p;
    if (r < 0n) { q -= 1n; r += p; }
    if (r * 2n > p || (r * 2n === p && (q & 1n) === 1n)) q += 1n;
    return q * p;
  }
  if (!isFinite(x)) return x;
  if (n >= 0) return Number(fixedRound(x, Math.min(n, 340)));
  const p = Math.pow(10, -n);
  return roundHalfEvenInt(x / p) * p;
}

/* ===================== TIPI E STRINGHE ===================== */
let idCounter = 1;
const idMap = new WeakMap();
function objId(o) { let i = idMap.get(o); if (!i) { i = idCounter++; idMap.set(o, i); } return i; }
const addr = o => '0x' + (0x7f3a2c000000 + objId(o) * 48).toString(16);

function typeName(v) {
  if (v === null) return 'NoneType';
  switch (typeof v) { case 'boolean': return 'bool'; case 'bigint': return 'int'; case 'number': return 'float'; case 'string': return 'str'; }
  if (Array.isArray(v)) return 'list';
  if (v instanceof PyTuple) return 'tuple';
  if (v instanceof PyDict) return 'dict';
  if (v instanceof PySet) return 'set';
  if (v instanceof PyRange) return 'range';
  if (v instanceof PyObj) return v.cls.name;
  if (v instanceof PyFunction) return 'function';
  if (v instanceof PyBuiltin) return v.tname ? 'type' : 'builtin_function_or_method';
  if (v instanceof PyClass) return 'type';
  if (v instanceof PyBound) return 'method';
  if (v instanceof PyModule) return 'module';
  if (v instanceof PyView) return 'dict_' + v.kind;
  if (v instanceof PyIter) return v.kind;
  return 'object';
}
function reprStr(s) {
  const q = s.indexOf("'") >= 0 && s.indexOf('"') < 0 ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === q) out += '\\' + q;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 32 || c === 127) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + q;
}
const reprBusy = new Set();
function pyRepr(v) {
  if (v === null) return 'None';
  switch (typeof v) {
    case 'boolean': return v ? 'True' : 'False';
    case 'bigint': return v.toString();
    case 'number': return fmtFloat(v);
    case 'string': return reprStr(v);
  }
  if (Array.isArray(v) || v instanceof PyTuple || v instanceof PyDict || v instanceof PySet) {
    if (reprBusy.has(v)) return Array.isArray(v) ? '[...]' : v instanceof PyDict ? '{...}' : '(...)';
    reprBusy.add(v);
    try {
      if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
      if (v instanceof PyTuple) return '(' + v.a.map(pyRepr).join(', ') + (v.a.length === 1 ? ',)' : ')');
      if (v instanceof PyDict) return '{' + Array.from(v.m.values()).map(e => pyRepr(e[0]) + ': ' + pyRepr(e[1])).join(', ') + '}';
      if (!v.m.size) return 'set()';
      return '{' + setEntries(v).map(e => pyRepr(e[0])).join(', ') + '}';
    } finally { reprBusy.delete(v); }
  }
  if (v instanceof PyRange) return 'range(' + v.start + ', ' + v.stop + (v.step !== 1n ? ', ' + v.step : '') + ')';
  if (v instanceof PyView) return 'dict_' + v.kind + '(' + pyRepr(toArray(v)) + ')';
  if (v instanceof PyObj) {
    const m = findAttr(v.cls, '__repr__');
    if (m !== undefined) { const r = callValue(m, [v]); if (typeof r !== 'string') raise('TypeError', '__repr__ returned non-string (type ' + typeName(r) + ')'); return r; }
    if (isExc(v)) return v.cls.name + '(' + v.d.get('args').a.map(pyRepr).join(', ') + ')';
    return '<__main__.' + v.cls.name + ' object at ' + addr(v) + '>';
  }
  if (v instanceof PyFunction) return '<function ' + v.name + ' at ' + addr(v) + '>';
  if (v instanceof PyBuiltin) return v.tname ? "<class '" + v.tname + "'>" : '<built-in function ' + v.name + '>';
  if (v instanceof PyClass) return "<class '__main__." + v.name + "'>";
  if (v instanceof PyBound) return '<bound method ' + (v.fn.name || '?') + ' of ' + pyRepr(v.self) + '>';
  if (v instanceof PyModule) return "<module '" + v.name + "' (built-in)>";
  if (v instanceof PyIter) return '<' + v.kind + ' object at ' + addr(v) + '>';
  return '<object>';
}
function excStr(o) {
  const a = o.d.get('args').a;
  if (a.length === 0) return '';
  if (a.length === 1) return o.cls.mro.indexOf(EXC.KeyError) >= 0 ? pyRepr(a[0]) : pyStr(a[0]);
  return pyRepr(new PyTuple(a));
}
function pyStr(v) {
  if (typeof v === 'string') return v;
  if (v instanceof PyObj) {
    const m = findAttr(v.cls, '__str__');
    if (m !== undefined) { const r = callValue(m, [v]); if (typeof r !== 'string') raise('TypeError', '__str__ returned non-string (type ' + typeName(r) + ')'); return r; }
    if (isExc(v)) return excStr(v);
  }
  return pyRepr(v);
}

function truthy(v) {
  if (v === null) return false;
  switch (typeof v) { case 'boolean': return v; case 'bigint': return v !== 0n; case 'number': return v !== 0; case 'string': return v.length > 0; }
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof PyTuple) return v.a.length > 0;
  if (v instanceof PyDict || v instanceof PySet) return v.m.size > 0;
  if (v instanceof PyRange) return rangeLen(v) > 0n;
  if (v instanceof PyView) return v.d.m.size > 0;
  if (v instanceof PyObj) {
    let m = findAttr(v.cls, '__bool__');
    if (m !== undefined) return truthy(callValue(m, [v]));
    m = findAttr(v.cls, '__len__');
    if (m !== undefined) return truthy(callValue(m, [v]));
  }
  return true;
}

/* ===================== FORMATTAZIONE ===================== */
const SPEC_RE = /^(?:([\s\S])?([<>=^]))?([+\- ])?(#)?(0)?(\d+)?([,_])?(?:\.(\d+))?([bcdeEfFgGnosxX%])?$/;
function padStr(s, width, fill, align) {
  const len = Array.from(s).length;
  if (len >= width) return s;
  const n = width - len;
  if (align === '<') return s + fill.repeat(n);
  if (align === '^') { const l = Math.floor(n / 2); return fill.repeat(l) + s + fill.repeat(n - l); }
  return fill.repeat(n) + s;
}
function groupDigits(s, sep) { return s.replace(/\B(?=(\d{3})+(?!\d))/g, sep); }
function formatValue(v, spec) {
  if (spec === '') return pyStr(v);
  const m = SPEC_RE.exec(spec);
  if (!m) raise('ValueError', 'Invalid format specifier');
  let fill = m[1], align = m[2];
  const sign = m[3], alt = m[4], zero = m[5], grp = m[7];
  let width = m[6] === undefined ? 0 : parseInt(m[6], 10);
  let prec = m[8] === undefined ? null : parseInt(m[8], 10);
  let type = m[9];
  if (zero && !align) { fill = '0'; align = '='; }
  fill = fill || ' ';
  if (!isNum(v)) {
    if (type && type !== 's') raise('ValueError', "Unknown format code '" + type + "' for object of type '" + typeName(v) + "'");
    let s = pyStr(v);
    if (prec !== null) s = Array.from(s).slice(0, prec).join('');
    return padStr(s, width, fill, align === '=' ? '<' : (align || '<'));
  }
  const integer = isInt(v);
  if (!type) type = integer ? 'd' : (prec === null ? 'r' : 'g');
  let neg = false, digits, prefix = '';
  if (integer && 'dnbBoxX'.indexOf(type) >= 0 || (integer && type === 'c')) {
    let n = toBig(v);
    neg = n < 0n; if (neg) n = -n;
    if (type === 'c') return padStr(String.fromCodePoint(Number(toBig(v))), width, fill, align || '<');
    if (type === 'd' || type === 'n') digits = n.toString();
    else if (type === 'b') { digits = n.toString(2); if (alt) prefix = '0b'; }
    else if (type === 'o') { digits = n.toString(8); if (alt) prefix = '0o'; }
    else { digits = n.toString(16); if (type === 'X') digits = digits.toUpperCase(); if (alt) prefix = type === 'X' ? '0X' : '0x'; }
    if (grp) digits = groupDigits(digits, grp);
  } else {
    if ('dnbBoxXc'.indexOf(type) >= 0) raise('ValueError', "Unknown format code '" + type + "' for object of type 'float'");
    const x = toF(v);
    neg = x < 0 || Object.is(x, -0);
    const ax = Math.abs(x);
    if (Number.isNaN(x)) { digits = 'nan'; neg = false; }
    else if (ax === Infinity) digits = 'inf';
    else if (type === 'f' || type === 'F') digits = fixedRound(ax, prec === null ? 6 : prec);
    else if (type === 'e' || type === 'E') digits = expFormat(ax, prec === null ? 6 : prec, type === 'E');
    else if (type === 'g' || type === 'G') digits = genFormat(ax, prec, !!alt, type === 'G');
    else if (type === '%') digits = fixedRound(ax * 100, prec === null ? 6 : prec) + '%';
    else digits = fmtFloat(ax);
    if (grp && /^\d/.test(digits)) { const parts = digits.split('.'); parts[0] = groupDigits(parts[0], grp); digits = parts.join('.'); }
  }
  const sg = neg ? '-' : (sign === '+' ? '+' : sign === ' ' ? ' ' : '');
  if (align === '=') {
    const len = Array.from(sg + prefix + digits).length;
    return sg + prefix + (len < width ? fill.repeat(width - len) : '') + digits;
  }
  return padStr(sg + prefix + digits, width, fill, align || '>');
}
function percentFormat(fmt, arg) {
  const isMap = arg instanceof PyDict;
  const args = arg instanceof PyTuple ? arg.a : [arg];
  let ai = 0;
  const out = fmt.replace(/%(?:\(([^)]*)\))?([-+ 0#]*)(\*|\d+)?(?:\.(\d+|\*))?([diouxXeEfFgGcrsa%])/g, (m, key, flags, width, prec, conv) => {
    if (conv === '%') return '%';
    let v;
    if (key !== undefined) {
      if (!isMap) raise('TypeError', 'format requires a mapping');
      const e = arg.m.get(hk(key));
      if (!e) raise('KeyError', key);
      v = e[1];
    } else {
      if (width === '*') { width = String(args[ai++]); }
      if (ai >= args.length) raise('TypeError', 'not enough arguments for format string');
      v = args[ai++];
    }
    const left = flags.indexOf('-') >= 0, zero = flags.indexOf('0') >= 0 && !left;
    const sg = flags.indexOf('+') >= 0 ? '+' : flags.indexOf(' ') >= 0 ? ' ' : '';
    const alt = flags.indexOf('#') >= 0 ? '#' : '';
    const w = width || '';
    if (conv === 's' || conv === 'r' || conv === 'a') {
      const s = conv === 's' ? pyStr(v) : pyRepr(v);
      return formatValue(s, (left ? '<' : '>') + w + (prec !== undefined ? '.' + prec : '') + 's');
    }
    if (conv === 'c') return formatValue(typeof v === 'string' ? v : String.fromCodePoint(Number(toBig(v))), (left ? '<' : '>') + w + 's');
    if (!isNum(v)) raise('TypeError', '%' + conv + ' format: a real number is required, not ' + typeName(v));
    let type = conv, val = v;
    if (conv === 'd' || conv === 'i' || conv === 'u') { type = 'd'; val = typeof v === 'number' ? BigInt(Math.trunc(v)) : toBig(v); }
    else if ('xXo'.indexOf(conv) >= 0) val = typeof v === 'number' ? BigInt(Math.trunc(v)) : toBig(v);
    const al = left ? '<' : (zero ? '' : '>');
    return formatValue(val, al + sg + alt + (zero ? '0' : '') + w + (prec !== undefined && type !== 'd' ? '.' + prec : '') + type);
  });
  if (ai < args.length && !isMap) raise('TypeError', 'not all arguments converted during string formatting');
  return out;
}
function strFormat(fmt, args, kw) {
  let auto = 0;
  return fmt.replace(/\{\{|\}\}|\{((?:[^{}]|\{[^{}]*\})*)\}/g, (m, field) => {
    if (m === '{{') return '{';
    if (m === '}}') return '}';
    const mm = /^([^!:]*)(?:!([rsa]))?(?::([\s\S]*))?$/.exec(field);
    const name = mm[1], conv = mm[2];
    let spec = mm[3] || '';
    let v;
    if (name === '') {
      if (auto >= args.length) raise('IndexError', 'Replacement index ' + auto + ' out of range for positional args tuple');
      v = args[auto++];
    } else {
      const base = /^[^.[]+/.exec(name)[0];
      if (/^\d+$/.test(base)) {
        if (+base >= args.length) raise('IndexError', 'Replacement index ' + base + ' out of range for positional args tuple');
        v = args[+base];
      } else {
        if (!kw || !(base in kw)) raise('KeyError', base);
        v = kw[base];
      }
      const rest = name.slice(base.length);
      const re = /\.(\w+)|\[([^\]]*)\]/g;
      let r;
      while ((r = re.exec(rest))) {
        if (r[1] !== undefined) v = getAttr(v, r[1]);
        else v = getItem(v, /^\d+$/.test(r[2]) ? BigInt(r[2]) : r[2]);
      }
    }
    if (conv === 'r' || conv === 'a') v = pyRepr(v);
    else if (conv === 's') v = pyStr(v);
    if (spec.indexOf('{') >= 0) spec = strFormat(spec, args, kw);
    return formatValue(v, spec);
  });
}

/* ===================== HASH, UGUAGLIANZA, ORDINE ===================== */
function hk(v) {
  switch (typeof v) {
    case 'bigint': return 'i' + v;
    case 'boolean': return v ? 'i1' : 'i0';
    case 'number': return Number.isInteger(v) ? 'i' + BigInt(v) : 'f' + v;
    case 'string': return 's' + v;
  }
  if (v === null) return 'N';
  if (v instanceof PyTuple) return 't(' + v.a.map(x => typeof x === 'string' ? 's' + JSON.stringify(x) : hk(x)).join(',') + ')';
  if (Array.isArray(v) || v instanceof PyDict || v instanceof PySet) raise('TypeError', "unhashable type: '" + typeName(v) + "'");
  if (v instanceof PyObj) {
    const h = findAttr(v.cls, '__hash__');
    if (h !== undefined && h !== null) return 'h' + hk(callValue(h, [v]));
    if (findAttr(v.cls, '__eq__') !== undefined) raise('TypeError', "unhashable type: '" + v.cls.name + "'");
  }
  return 'o' + objId(v);
}
function dictSet(d, k, v) { d.m.set(hk(k), [k, v]); }
function dictGet(d, k) { const e = d.m.get(hk(k)); return e === undefined ? undefined : e[1]; }

function numEq(a, b) {
  if (isInt(a) && isInt(b)) return toBig(a) === toBig(b);
  return toF(a) === toF(b);
}
function eq(a, b) {
  if (a === b) return true;
  if (isNum(a) && isNum(b)) return numEq(a, b);
  if (a === null || b === null || typeof a === 'string' || typeof b === 'string') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof PyTuple) {
    if (!(b instanceof PyTuple) || a.a.length !== b.a.length) return false;
    for (let i = 0; i < a.a.length; i++) if (!eq(a.a[i], b.a[i])) return false;
    return true;
  }
  if (a instanceof PyDict) {
    if (!(b instanceof PyDict) || a.m.size !== b.m.size) return false;
    for (const [k, e] of a.m) { const o = b.m.get(k); if (!o || !eq(e[1], o[1])) return false; }
    return true;
  }
  if (a instanceof PySet) {
    if (!(b instanceof PySet) || a.m.size !== b.m.size) return false;
    for (const k of a.m.keys()) if (!b.m.has(k)) return false;
    return true;
  }
  if (a instanceof PyRange && b instanceof PyRange) return eq(toArray(a), toArray(b));
  if (a instanceof PyObj) { const m = findAttr(a.cls, '__eq__'); if (m !== undefined) return truthy(callValue(m, [a, b])); }
  if (b instanceof PyObj) { const m = findAttr(b.cls, '__eq__'); if (m !== undefined) return truthy(callValue(m, [b, a])); }
  return false;
}
function less(a, b) {
  if (isNum(a) && isNum(b)) return isInt(a) && isInt(b) ? toBig(a) < toBig(b) : toF(a) < toF(b);
  if (typeof a === 'string' && typeof b === 'string') return a < b;
  if (Array.isArray(a) && Array.isArray(b)) return seqLess(a, b);
  if (a instanceof PyTuple && b instanceof PyTuple) return seqLess(a.a, b.a);
  if (a instanceof PyObj) { const m = findAttr(a.cls, '__lt__'); if (m !== undefined) return truthy(callValue(m, [a, b])); }
  if (b instanceof PyObj) { const m = findAttr(b.cls, '__gt__'); if (m !== undefined) return truthy(callValue(m, [b, a])); }
  if (a instanceof PySet && b instanceof PySet) { if (a.m.size >= b.m.size) return false; for (const k of a.m.keys()) if (!b.m.has(k)) return false; return true; }
  return undefined;
}
function seqLess(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (!eq(a[i], b[i])) { const r = less(a[i], b[i]); if (r === undefined) return undefined; return r; }
  }
  return a.length < b.length;
}
function ltStrict(a, b) {
  const r = less(a, b);
  if (r === undefined) raise('TypeError', "'<' not supported between instances of '" + typeName(a) + "' and '" + typeName(b) + "'");
  return r;
}
function ordered(op, a, b) {
  if (isNum(a) && isNum(b)) {
    if (isInt(a) && isInt(b)) { const x = toBig(a), y = toBig(b); return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y; }
    const x = toF(a), y = toF(b);
    return op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : x >= y;
  }
  let r;
  if (op === '<') r = less(a, b);
  else if (op === '>') r = less(b, a);
  else {
    const m = a instanceof PyObj ? findAttr(a.cls, op === '<=' ? '__le__' : '__ge__') : undefined;
    if (m !== undefined) return truthy(callValue(m, [a, b]));
    r = op === '<=' ? less(a, b) : less(b, a);
    if (r === false) r = eq(a, b);
  }
  if (r === undefined) raise('TypeError', "'" + op + "' not supported between instances of '" + typeName(a) + "' and '" + typeName(b) + "'");
  return r;
}
function isIdent(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b);
  return false;
}
function contains(c, x) {
  if (Array.isArray(c)) { for (let i = 0; i < c.length; i++) if (eq(c[i], x)) return true; return false; }
  if (c instanceof PyTuple) { for (const y of c.a) if (eq(y, x)) return true; return false; }
  if (typeof c === 'string') {
    if (typeof x !== 'string') raise('TypeError', "'in <string>' requires string as left operand, not " + typeName(x));
    return c.indexOf(x) >= 0;
  }
  if (c instanceof PyDict || c instanceof PySet) return c.m.has(hk(x));
  if (c instanceof PyRange) {
    if (!isNum(x)) return false;
    if (typeof x === 'number' && !Number.isInteger(x)) return false;
    const n = typeof x === 'number' ? BigInt(x) : toBig(x);
    if (c.step > 0n ? (n < c.start || n >= c.stop) : (n > c.start || n <= c.stop)) return false;
    return (n - c.start) % c.step === 0n;
  }
  if (c instanceof PyView) {
    if (c.kind === 'keys') return c.d.m.has(hk(x));
    return contains(toArray(c), x);
  }
  if (c instanceof PyObj) {
    const m = findAttr(c.cls, '__contains__');
    if (m !== undefined) return truthy(callValue(m, [c, x]));
    return contains(toArray(c), x);
  }
  raise('TypeError', "argument of type '" + typeName(c) + "' is not iterable");
}

/* ===================== ARITMETICA ===================== */
function floorDivBig(x, y) { let q = x / y; if ((x % y !== 0n) && ((x < 0n) !== (y < 0n))) q -= 1n; return q; }
function modBig(x, y) { let r = x % y; if (r !== 0n && ((r < 0n) !== (y < 0n))) r += y; return r; }
function numop(op, a, b) {
  if (isInt(a) && isInt(b)) {
    const x = toBig(a), y = toBig(b);
    switch (op) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/': if (y === 0n) raise('ZeroDivisionError', 'division by zero'); if ((x > 9007199254740991n || x < -9007199254740991n || y > 9007199254740991n || y < -9007199254740991n)) return ratioToNumber(x, y); return Number(x) / Number(y);
      case '//': if (y === 0n) raise('ZeroDivisionError', 'integer division or modulo by zero'); return floorDivBig(x, y);
      case '%': if (y === 0n) raise('ZeroDivisionError', 'integer modulo by zero'); return modBig(x, y);
      case '**':
        if (y < 0n) { if (x === 0n) raise('ZeroDivisionError', 'zero to a negative power'); return Math.pow(Number(x), Number(y)); }
        if (y > 100000n) raise('OverflowError', 'esponente troppo grande');
        return x ** y;
      case '&': return x & y;
      case '|': return x | y;
      case '^': return x ^ y;
      case '<<': if (y < 0n) raise('ValueError', 'negative shift count'); if (y > 100000n) raise('OverflowError', 'shift troppo grande'); return x << y;
      case '>>': if (y < 0n) raise('ValueError', 'negative shift count'); return x >> y;
    }
  } else {
    const x = toF(a), y = toF(b);
    switch (op) {
      case '+': return x + y;
      case '-': return x - y;
      case '*': return x * y;
      case '/': if (y === 0) raise('ZeroDivisionError', 'division by zero'); return x / y;
      case '//': if (y === 0) raise('ZeroDivisionError', 'division by zero'); return Math.floor(x / y);
      case '%': { if (y === 0) raise('ZeroDivisionError', 'division by zero'); let r = x % y; if (r !== 0 && ((r < 0) !== (y < 0))) r += y; return r; }
      case '**':
        if (x === 0 && y < 0) raise('ZeroDivisionError', 'zero to a negative power');
        if (x < 0 && !Number.isInteger(y)) raise('ValueError', 'il risultato sarebbe un numero complesso (non supportato)');
        return Math.pow(x, y);
    }
  }
  raise('TypeError', "unsupported operand type(s) for " + op + ": '" + typeName(a) + "' and '" + typeName(b) + "'");
}
const DUNDER = { '+': ['__add__', '__radd__'], '-': ['__sub__', '__rsub__'], '*': ['__mul__', '__rmul__'], '/': ['__truediv__', '__rtruediv__'], '//': ['__floordiv__', '__rfloordiv__'], '%': ['__mod__', '__rmod__'], '**': ['__pow__', '__rpow__'] };
function setOp(op, a, b) {
  const r = new PySet();
  if (op === '|') { for (const [k, e] of a.m) r.m.set(k, e); for (const [k, e] of b.m) r.m.set(k, e); }
  else if (op === '&') { for (const [k, e] of a.m) if (b.m.has(k)) r.m.set(k, e); }
  else if (op === '-') { for (const [k, e] of a.m) if (!b.m.has(k)) r.m.set(k, e); }
  else { for (const [k, e] of a.m) if (!b.m.has(k)) r.m.set(k, e); for (const [k, e] of b.m) if (!a.m.has(k)) r.m.set(k, e); }
  return r;
}
function repeatSeq(s, n) {
  const k = Number(toBig(n));
  if (k <= 0) return Array.isArray(s) ? [] : s instanceof PyTuple ? new PyTuple([]) : '';
  if (typeof s === 'string') { if (s.length * k > 5e6) raise('MemoryError', 'risultato troppo grande'); return s.repeat(k); }
  if (s.length * k > 5e6 || (s.a && s.a.length * k > 5e6)) raise('OverflowError', 'risultato troppo grande');
  if (Array.isArray(s)) { let out = []; for (let i = 0; i < k; i++) out = out.concat(s); return out; }
  let out = []; for (let i = 0; i < k; i++) out = out.concat(s.a); return new PyTuple(out);
}
function binop(op, a, b) {
  if (isNum(a) && isNum(b)) return numop(op, a, b);
  switch (op) {
    case '+':
      if (typeof a === 'string' && typeof b === 'string') return a + b;
      if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
      if (a instanceof PyTuple && b instanceof PyTuple) return new PyTuple(a.a.concat(b.a));
      break;
    case '*':
      if ((typeof a === 'string' || Array.isArray(a) || a instanceof PyTuple) && isInt(b)) return repeatSeq(a, b);
      if ((typeof b === 'string' || Array.isArray(b) || b instanceof PyTuple) && isInt(a)) return repeatSeq(b, a);
      break;
    case '%': if (typeof a === 'string') return percentFormat(a, b); break;
    case '|': case '&': case '^': case '-':
      if (a instanceof PySet && b instanceof PySet) return setOp(op, a, b);
      break;
  }
  const dn = DUNDER[op];
  if (a instanceof PyObj && dn) { const m = findAttr(a.cls, dn[0]); if (m !== undefined) return callValue(m, [a, b]); }
  if (b instanceof PyObj && dn) { const m = findAttr(b.cls, dn[1]); if (m !== undefined) return callValue(m, [b, a]); }
  if (op === '+' && (typeof a === 'string' || Array.isArray(a) || a instanceof PyTuple)) raise('TypeError', 'can only concatenate ' + typeName(a) + ' (not "' + typeName(b) + '") to ' + typeName(a));
  if (op === '*' && (typeof a === 'string' || Array.isArray(a) || a instanceof PyTuple)) raise('TypeError', "can't multiply sequence by non-int of type '" + typeName(b) + "'");
  if (op === '*' && (typeof b === 'string' || Array.isArray(b) || b instanceof PyTuple)) raise('TypeError', "can't multiply sequence by non-int of type '" + typeName(a) + "'");
  raise('TypeError', "unsupported operand type(s) for " + (op === '**' ? '** or pow()' : op) + ": '" + typeName(a) + "' and '" + typeName(b) + "'");
}
function unop(op, v) {
  if (op === '-') {
    if (typeof v === 'bigint') return -v;
    if (typeof v === 'boolean') return v ? -1n : 0n;
    if (typeof v === 'number') return -v;
    if (v instanceof PyObj) { const m = findAttr(v.cls, '__neg__'); if (m !== undefined) return callValue(m, [v]); }
  } else if (op === '+') {
    if (isNum(v)) return typeof v === 'boolean' ? toBig(v) : v;
  } else if (op === '~') {
    if (isInt(v)) return ~toBig(v);
  }
  raise('TypeError', 'bad operand type for unary ' + op + ": '" + typeName(v) + "'");
}

/* ===================== ITERAZIONE ===================== */
function rangeLen(r) {
  if (r.step > 0n) return r.stop > r.start ? (r.stop - r.start + r.step - 1n) / r.step : 0n;
  return r.start > r.stop ? (r.start - r.stop - r.step - 1n) / (-r.step) : 0n;
}
const astral = /[\ud800-\udfff]/;
function strChars(s) { return astral.test(s) ? Array.from(s) : null; }
function strLen(s) { return astral.test(s) ? Array.from(s).length : s.length; }
function getIter(v) {
  if (Array.isArray(v)) { let i = 0; return () => i < v.length ? v[i++] : DONE; }
  if (v instanceof PyTuple) { const a = v.a; let i = 0; return () => i < a.length ? a[i++] : DONE; }
  if (typeof v === 'string') { const ch = Array.from(v); let i = 0; return () => i < ch.length ? ch[i++] : DONE; }
  if (v instanceof PyRange) {
    let cur = v.start;
    const st = v.step, stop = v.stop;
    if (st > 0n) return () => { if (cur < stop) { const r = cur; cur += st; return r; } return DONE; };
    return () => { if (cur > stop) { const r = cur; cur += st; return r; } return DONE; };
  }
  if (v instanceof PyDict) { const ks = Array.from(v.m.values()).map(e => e[0]); let i = 0; return () => i < ks.length ? ks[i++] : DONE; }
  if (v instanceof PySet) { const ks = setEntries(v).map(e => e[0]); let i = 0; return () => i < ks.length ? ks[i++] : DONE; }
  if (v instanceof PyView) {
    const es = Array.from(v.d.m.values());
    const arr = v.kind === 'keys' ? es.map(e => e[0]) : v.kind === 'values' ? es.map(e => e[1]) : es.map(e => new PyTuple([e[0], e[1]]));
    let i = 0; return () => i < arr.length ? arr[i++] : DONE;
  }
  if (v instanceof PyIter) return () => v.nx();
  if (v instanceof PyObj) {
    const m = findAttr(v.cls, '__iter__');
    if (m !== undefined) {
      const it = callValue(m, [v]);
      if (it instanceof PyObj && findAttr(it.cls, '__next__') !== undefined) {
        const nx = findAttr(it.cls, '__next__');
        return () => {
          try { return callValue(nx, [it]); }
          catch (e) { if (e instanceof PyThrow && isSubclass(e.obj.cls, EXC.StopIteration)) return DONE; throw e; }
        };
      }
      return getIter(it);
    }
    const g = findAttr(v.cls, '__getitem__');
    if (g !== undefined) {
      let i = 0n;
      return () => {
        try { return callValue(g, [v, i++]); }
        catch (e) { if (e instanceof PyThrow && isSubclass(e.obj.cls, EXC.IndexError)) return DONE; throw e; }
      };
    }
  }
  raise('TypeError', "'" + typeName(v) + "' object is not iterable");
}
function toArray(v) {
  if (Array.isArray(v)) return v.slice();
  if (v instanceof PyTuple) return v.a.slice();
  const nx = getIter(v), out = [];
  for (let x = nx(); x !== DONE; x = nx()) {
    out.push(x);
    if (out.length > 5e6) raise('MemoryError', 'sequenza troppo lunga');
  }
  return out;
}
function setEntries(s) {
  const es = Array.from(s.m.values());
  if (es.length < 2) return es;
  for (const e of es) { if (typeof e[0] !== 'bigint' || e[0] < 0n) return es; }
  let size = 8;
  while (es.length * 5 >= size * 3) size *= 2;
  const mask = BigInt(size - 1);
  return es.map((e, i) => [Number(e[0] & mask), i, e]).sort((p, q) => p[0] - q[0] || p[1] - q[1]).map(p => p[2]);
}
function makeSet(src) {
  const s = new PySet();
  if (src !== undefined) { const nx = getIter(src); for (let x = nx(); x !== DONE; x = nx()) s.m.set(hk(x), [x, null]); }
  return s;
}

/* ===================== INDICI E FETTE ===================== */
function idxBig(i, what) {
  if (typeof i === 'bigint') return i;
  if (typeof i === 'boolean') return i ? 1n : 0n;
  raise('TypeError', what + ' indices must be integers or slices, not ' + typeName(i));
}
function normIdx(i, len, what) {
  let k = Number(idxBig(i, what));
  if (k < 0) k += len;
  if (k < 0 || k >= len) raise('IndexError', what + ' index out of range');
  return k;
}
function sliceBounds(sl, len) {
  const bi = x => Number(idxBig(x, 'slice'));
  const step = sl.step === null ? 1 : bi(sl.step);
  if (step === 0) raise('ValueError', 'slice step cannot be zero');
  let start, stop;
  if (step > 0) {
    start = sl.lo === null ? 0 : bi(sl.lo);
    stop = sl.hi === null ? len : bi(sl.hi);
    if (start < 0) { start += len; if (start < 0) start = 0; } else if (start > len) start = len;
    if (stop < 0) { stop += len; if (stop < 0) stop = 0; } else if (stop > len) stop = len;
  } else {
    start = sl.lo === null ? len - 1 : bi(sl.lo);
    stop = sl.hi === null ? -1 : bi(sl.hi);
    if (start < 0) { start += len; if (start < 0) start = -1; } else if (start >= len) start = len - 1;
    if (sl.hi !== null) { if (stop < 0) { stop += len; if (stop < 0) stop = -1; } else if (stop >= len) stop = len - 1; }
  }
  return { start, stop, step };
}
function sliceArr(arr, sl) {
  const b = sliceBounds(sl, arr.length), out = [];
  if (b.step > 0) for (let i = b.start; i < b.stop; i += b.step) out.push(arr[i]);
  else for (let i = b.start; i > b.stop; i += b.step) out.push(arr[i]);
  return out;
}
function getItem(o, i) {
  if (Array.isArray(o)) return i instanceof PySlice ? sliceArr(o, i) : o[normIdx(i, o.length, 'list')];
  if (typeof o === 'string') {
    const ch = strChars(o);
    if (i instanceof PySlice) return ch ? sliceArr(ch, i).join('') : sliceArr(o.split(''), i).join('');
    return ch ? ch[normIdx(i, ch.length, 'string')] : o[normIdx(i, o.length, 'string')];
  }
  if (o instanceof PyTuple) return i instanceof PySlice ? new PyTuple(sliceArr(o.a, i)) : o.a[normIdx(i, o.a.length, 'tuple')];
  if (o instanceof PyDict) {
    const e = o.m.get(hk(i));
    if (e === undefined) throw new PyThrow(makeExc('KeyError', i));
    return e[1];
  }
  if (o instanceof PyRange) {
    const n = Number(rangeLen(o));
    if (i instanceof PySlice) return sliceArr(toArray(o), i);
    return o.start + BigInt(normIdx(i, n, 'range')) * o.step;
  }
  if (o instanceof PyObj) {
    const m = findAttr(o.cls, '__getitem__');
    if (m !== undefined) return callValue(m, [o, i]);
  }
  raise('TypeError', "'" + typeName(o) + "' object is not subscriptable");
}
function setItem(o, i, v) {
  if (Array.isArray(o)) {
    if (i instanceof PySlice) {
      const b = sliceBounds(i, o.length), items = toArray(v);
      if (b.step === 1) { o.splice(b.start, Math.max(0, b.stop - b.start), ...items); return; }
      const idx = []; if (b.step > 0) for (let k = b.start; k < b.stop; k += b.step) idx.push(k); else for (let k = b.start; k > b.stop; k += b.step) idx.push(k);
      if (idx.length !== items.length) raise('ValueError', 'attempt to assign sequence of size ' + items.length + ' to extended slice of size ' + idx.length);
      idx.forEach((k, n) => { o[k] = items[n]; });
      return;
    }
    o[normIdx(i, o.length, 'list assignment')] = v; return;
  }
  if (o instanceof PyDict) { dictSet(o, i, v); return; }
  if (o instanceof PyObj) { const m = findAttr(o.cls, '__setitem__'); if (m !== undefined) { callValue(m, [o, i, v]); return; } }
  raise('TypeError', "'" + typeName(o) + "' object does not support item assignment");
}
function delItem(o, i) {
  if (Array.isArray(o)) {
    if (i instanceof PySlice) {
      const b = sliceBounds(i, o.length), idx = [];
      if (b.step > 0) for (let k = b.start; k < b.stop; k += b.step) idx.push(k); else for (let k = b.start; k > b.stop; k += b.step) idx.push(k);
      idx.sort((x, y) => y - x).forEach(k => o.splice(k, 1)); return;
    }
    o.splice(normIdx(i, o.length, 'list assignment'), 1); return;
  }
  if (o instanceof PyDict) { if (!o.m.delete(hk(i))) throw new PyThrow(makeExc('KeyError', i)); return; }
  raise('TypeError', "'" + typeName(o) + "' object doesn't support item deletion");
}

/* ===================== ARITMETICA ESATTA ===================== */
function bitLen(n) { return n === 0n ? 0 : n.toString(2).length; }
function ratioToNumber(n, d) {
  if (d < 0n) { n = -n; d = -d; }
  if (n === 0n) return 0;
  const neg = n < 0n; if (neg) n = -n;
  const shift = 55 - (bitLen(n) - bitLen(d));
  let q, r;
  if (shift >= 0) { const num = n << BigInt(shift); q = num / d; r = num % d; }
  else { const den = d << BigInt(-shift); q = n / den; r = n % den; }
  if (r !== 0n) q |= 1n;
  let x = Number(q);
  const e = -shift, h = Math.trunc(e / 2);
  x = x * Math.pow(2, h) * Math.pow(2, e - h);
  return neg ? -x : x;
}
function isqrtBig(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt((bitLen(n) + 1) >> 1);
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x; x = y; }
}
function sqrtFrac(n, m) {
  if (n === 0n) return 0;
  const q = Math.floor((bitLen(n) - bitLen(m) - 109) / 2);
  const rto = (a, b) => { const s = isqrtBig(a / b); return (s * s * b !== a) ? (s | 1n) : s; };
  if (q >= 0) return ratioToNumber(rto(n, m << BigInt(2 * q)) << BigInt(q), 1n);
  return ratioToNumber(rto(n << BigInt(-2 * q), m), 1n << BigInt(-q));
}
function scaledInts(items) {
  let kmin = 0;
  const parts = items.map(x => {
    if (isInt(x)) return [toBig(x), 0];
    const [m, e] = floatParts(x);
    if (e < kmin) kmin = e;
    return [x < 0 ? -m : m, e];
  });
  return { X: parts.map(p => p[0] << BigInt(p[1] - kmin)), P: -kmin };
}
function numList(v, fname) {
  const a = toArray(v);
  a.forEach(x => { if (!isNum(x)) raise('TypeError', "unsupported operand type(s) in " + fname + ": '" + typeName(x) + "'"); });
  return a;
}
function neumaierSum(items, start) {
  let f = start, c = 0;
  for (const it of items) {
    const x = toF(it), t = f + x;
    if (Math.abs(f) >= Math.abs(x)) c += (f - t) + x; else c += (x - t) + f;
    f = t;
  }
  return isFinite(c) ? f + c : f;
}
function pySum(iterable, start) {
  const items = toArray(iterable);
  let res = start === undefined ? 0n : start, i = 0;
  while (i < items.length && isInt(items[i]) && isInt(res)) { res = toBig(res) + toBig(items[i]); i++; }
  if (i < items.length && isNum(res) && typeof items[i] === 'number' || (i < items.length && typeof res === 'number' && isNum(items[i]))) {
    const rest = [];
    let j = i;
    while (j < items.length && isNum(items[j])) { rest.push(items[j]); j++; }
    res = neumaierSum(rest, toF(res)); i = j;
  }
  for (; i < items.length; i++) res = binop('+', res, items[i]);
  return res;
}

/* ===================== ATTRIBUTI ===================== */
function noAttr(o, name) {
  if (o instanceof PyModule) raise('AttributeError', "module '" + o.name + "' has no attribute '" + name + "'");
  if (o instanceof PyClass) raise('AttributeError', "type object '" + o.name + "' has no attribute '" + name + "'");
  raise('AttributeError', "'" + typeName(o) + "' object has no attribute '" + name + "'");
}
function bindAttr(v, self, cls) {
  if (v instanceof PyFunction) return new PyBound(v, self);
  if (v instanceof PyProperty) { if (v.fget === null) raise('AttributeError', 'unreadable attribute'); return callValue(v.fget, [self]); }
  if (v instanceof PyStatic) return v.f;
  if (v instanceof PyClassMethod) return new PyBound(v.f, cls);
  if (v instanceof PyBuiltin && !v.tname) return new PyBound(v, self);
  return v;
}
function getAttr(o, name) {
  if (o instanceof PyObj) {
    const own = o.d.get(name);
    if (own !== undefined) return own;
    const cv = findAttr(o.cls, name);
    if (cv !== undefined) return bindAttr(cv, o, o.cls);
    if (name === '__class__') return o.cls;
    const ga = findAttr(o.cls, '__getattr__');
    if (ga !== undefined) return callValue(ga, [o, name]);
    noAttr(o, name);
  }
  if (o instanceof PyClass) {
    if (name === '__name__') return o.name;
    if (name === '__mro__') return new PyTuple(o.mro.slice());
    if (name === '__bases__') return new PyTuple(o.bases.slice());
    const cv = findAttr(o, name);
    if (cv === undefined) noAttr(o, name);
    if (cv instanceof PyProperty) return cv;
    if (cv instanceof PyStatic) return cv.f;
    if (cv instanceof PyClassMethod) return new PyBound(cv.f, o);
    return cv;
  }
  if (o instanceof PySuper) {
    const mro = o.obj instanceof PyClass ? o.obj.mro : o.obj.cls.mro;
    const k = mro.indexOf(o.cls);
    for (let i = k + 1; i < mro.length; i++) {
      const v = mro[i].d.get(name);
      if (v !== undefined) return bindAttr(v, o.obj, o.obj instanceof PyClass ? o.obj : o.obj.cls);
    }
    raise('AttributeError', "'super' object has no attribute '" + name + "'");
  }
  if (o instanceof PyModule) {
    const v = o.d.get(name);
    if (v === undefined) noAttr(o, name);
    return v;
  }
  if (o instanceof PyFunction) {
    if (name === '__name__') return o.name;
    if (name === '__doc__') return null;
    noAttr(o, name);
  }
  if (o instanceof PyBuiltin && o.tname) {
    if (name === '__name__') return o.tname;
  }
  if (o instanceof PyBuiltin && name === '__name__') return o.name;
  if (o instanceof PyBound) {
    if (name === '__name__') return o.fn.name;
    if (name === '__self__') return o.self;
  }
  if (name === '__class__') return typeOf(o);
  const tn = typeName(o);
  const tbl = METHODS[tn];
  if (tbl && tbl[name]) { const f = tbl[name]; return new PyBuiltin(name, (a, kw) => f(o, a, kw || {})); }
  if (typeof o === 'number' && (name === 'real' || name === 'imag')) return name === 'real' ? o : 0;
  if (isInt(o) && (name === 'real' || name === 'imag' || name === 'numerator' || name === 'denominator')) return name === 'imag' ? 0n : name === 'denominator' ? 1n : toBig(o);
  noAttr(o, name);
}
function setAttr(o, name, v) {
  if (o instanceof PyObj) {
    const cv = findAttr(o.cls, name);
    if (cv instanceof PyProperty) {
      if (cv.fset === null) raise('AttributeError', "property '" + name + "' of '" + o.cls.name + "' object has no setter");
      callValue(cv.fset, [o, v]); return;
    }
    const ss = findAttr(o.cls, '__setattr__');
    if (ss !== undefined && !(ss instanceof PyBuiltin)) { callValue(ss, [o, name, v]); return; }
    o.d.set(name, v); return;
  }
  if (o instanceof PyClass) { o.d.set(name, v); return; }
  if (o instanceof PyFunction) { o[name] = v; return; }
  raise('AttributeError', "'" + typeName(o) + "' object has no attribute '" + name + "' and no __dict__ for setting new attributes");
}

/* ===================== CHIAMATE ===================== */
function isCallable(v) {
  return v instanceof PyFunction || v instanceof PyBuiltin || v instanceof PyClass || v instanceof PyBound ||
    (v instanceof PyObj && findAttr(v.cls, '__call__') !== undefined);
}
function callValue(f, args, kw) {
  if (f instanceof PyFunction) return callFunction(f, args, kw || null);
  if (f instanceof PyBuiltin) return f.fn(args, kw || null);
  if (f instanceof PyBound) return callValue(f.fn, [f.self].concat(args), kw);
  if (f instanceof PyClass) return instantiate(f, args, kw || null);
  if (f instanceof PyObj) {
    const m = findAttr(f.cls, '__call__');
    if (m !== undefined) return callValue(m, [f].concat(args), kw);
  }
  raise('TypeError', "'" + typeName(f) + "' object is not callable");
}
function instantiate(cls, args, kw) {
  const o = new PyObj(cls);
  if (isSubclass(cls, EXC.BaseException)) o.d.set('args', new PyTuple(args.slice()));
  const init = findAttr(cls, '__init__');
  if (init !== undefined) {
    const r = callValue(init, [o].concat(args), kw);
    if (r !== null && !(init instanceof PyBuiltin)) raise('TypeError', "__init__() should return None, not '" + typeName(r) + "'");
  } else if ((args.length || (kw && Object.keys(kw).length)) && cls !== C_object) {
    raise('TypeError', cls.name + '() takes no arguments');
  }
  return o;
}

/* ===================== METODI DEI TIPI ===================== */
const METHODS = { str: {}, list: {}, tuple: {}, dict: {}, set: {}, int: {}, float: {}, bool: {}, range: {}, dict_keys: {}, dict_values: {}, dict_items: {} };
function argn(name, a, min, max) {
  if (a.length < min || a.length > max) {
    raise('TypeError', name + '() takes ' + (min === max ? 'exactly ' + min : max === Infinity ? 'at least ' + min : 'from ' + min + ' to ' + max) + ' argument' + ((max === 1 || (min === max && min === 1)) ? '' : 's') + ' (' + a.length + ' given)');
  }
}
function needStr(v, what) { if (typeof v !== 'string') raise('TypeError', what + ' must be str, not ' + typeName(v)); return v; }
const WS = /[ \t\n\r\f\v\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\x1c-\x1f\x85]/;
function stripChars(s, chars, left, right) {
  const set = chars === undefined || chars === null ? null : needStr(chars, 'strip arg');
  const bad = c => set === null ? WS.test(c) : set.indexOf(c) >= 0;
  let i = 0, j = s.length;
  if (left) while (i < j && bad(s[i])) i++;
  if (right) while (j > i && bad(s[j - 1])) j--;
  return s.slice(i, j);
}
function splitStr(s, sep, max, fromRight) {
  max = max === undefined || max === null ? -1 : Number(toBig(max));
  if (sep === undefined || sep === null) {
    const out = [];
    const t = fromRight ? s.replace(/[\s\u0085]+$/, '') : s.replace(/^[\s\u0085]+/, '');
    if (!fromRight) {
      let rest = t;
      while (rest.length) {
        if (max >= 0 && out.length >= max) { out.push(rest.replace(/[\s\u0085]+$/, '')); return out; }
        const m = /[\s\u0085]+/.exec(rest);
        if (!m) { out.push(rest); return out; }
        out.push(rest.slice(0, m.index));
        rest = rest.slice(m.index + m[0].length);
      }
      return out;
    }
    let rest = t;
    while (rest.length) {
      if (max >= 0 && out.length >= max) { out.unshift(rest.replace(/^[\s\u0085]+/, '')); return out; }
      const m = /[\s\u0085]+(?=\S*$)/.exec(rest);
      if (!m) { out.unshift(rest); return out; }
      out.unshift(rest.slice(m.index + m[0].length));
      rest = rest.slice(0, m.index);
    }
    return out;
  }
  needStr(sep, 'sep');
  if (sep === '') raise('ValueError', 'empty separator');
  let parts = s.split(sep);
  if (max >= 0 && parts.length - 1 > max) {
    if (fromRight) { const head = parts.slice(0, parts.length - max).join(sep); parts = [head].concat(parts.slice(parts.length - max)); }
    else { const tail = parts.slice(max).join(sep); parts = parts.slice(0, max).concat([tail]); }
  }
  return parts;
}
function pad(s, w, fill, mode) {
  w = Number(toBig(w)); fill = fill === undefined ? ' ' : fill;
  const len = strLen(s);
  if (w <= len) return s;
  const n = w - len;
  if (mode === 'l') return s + fill.repeat(n);
  if (mode === 'r') return fill.repeat(n) + s;
  const left = Math.floor(n / 2) + (n & w & 1);
  return fill.repeat(left) + s + fill.repeat(n - left);
}
function clampIdx(i, len, dflt) {
  if (i === undefined || i === null) return dflt;
  let k = Number(idxBig(i, 'slice'));
  if (k < 0) { k += len; if (k < 0) k = 0; }
  return k > len ? len : k;
}
const S = METHODS.str;
S.upper = s => s.toUpperCase();
S.lower = s => s.toLowerCase();
S.strip = (s, a) => stripChars(s, a[0], true, true);
S.lstrip = (s, a) => stripChars(s, a[0], true, false);
S.rstrip = (s, a) => stripChars(s, a[0], false, true);
S.split = (s, a, kw) => splitStr(s, a.length ? a[0] : kw.sep, a.length > 1 ? a[1] : kw.maxsplit, false);
S.rsplit = (s, a, kw) => splitStr(s, a.length ? a[0] : kw.sep, a.length > 1 ? a[1] : kw.maxsplit, true);
S.splitlines = (s, a) => { const keep = a.length && truthy(a[0]); const out = s.match(/[^\n\r]*(\r\n|\n|\r|$)/g) || []; const r = out.filter((x, i) => x !== '' || false).map(x => keep ? x : x.replace(/(\r\n|\n|\r)$/, '')); return r; };
S.join = (s, a) => { const items = toArray(a[0]); items.forEach((x, i) => { if (typeof x !== 'string') raise('TypeError', 'sequence item ' + i + ': expected str instance, ' + typeName(x) + ' found'); }); return items.join(s); };
S.replace = (s, a) => {
  const old = needStr(a[0], 'replace() argument 1'), nw = needStr(a[1], 'replace() argument 2');
  const cnt = a.length > 2 ? Number(toBig(a[2])) : -1;
  if (cnt < 0) return old === '' ? Array.from(s).join(nw).replace(/^/, nw) + nw : s.split(old).join(nw);
  let out = '', i = 0, c = 0;
  if (old === '') { const ch = Array.from(s); let r = ''; for (let k = 0; k <= ch.length; k++) { if (c < cnt) { r += nw; c++; } if (k < ch.length) r += ch[k]; } return r; }
  for (;;) { const k = s.indexOf(old, i); if (k < 0 || c >= cnt) break; out += s.slice(i, k) + nw; i = k + old.length; c++; }
  return out + s.slice(i);
};
S.find = (s, a) => { const sub = needStr(a[0], 'must be str'); const st = clampIdx(a[1], s.length, 0), en = clampIdx(a[2], s.length, s.length); const k = s.slice(0, en).indexOf(sub, st); return BigInt(k); };
S.rfind = (s, a) => { const sub = needStr(a[0], 'must be str'); const st = clampIdx(a[1], s.length, 0), en = clampIdx(a[2], s.length, s.length); const k = s.slice(st, en).lastIndexOf(sub); return BigInt(k < 0 ? -1 : k + st); };
S.index = (s, a) => { const k = S.find(s, a); if (k < 0n) raise('ValueError', 'substring not found'); return k; };
S.rindex = (s, a) => { const k = S.rfind(s, a); if (k < 0n) raise('ValueError', 'substring not found'); return k; };
S.count = (s, a) => { const sub = needStr(a[0], 'must be str'); const st = clampIdx(a[1], s.length, 0), en = clampIdx(a[2], s.length, s.length); const t = s.slice(st, en); if (sub === '') return BigInt(strLen(t) + 1); return BigInt(t.split(sub).length - 1); };
function affixes(a) { return a[0] instanceof PyTuple ? a[0].a : [a[0]]; }
S.startswith = (s, a) => { const st = clampIdx(a[1], s.length, 0), en = clampIdx(a[2], s.length, s.length); const t = s.slice(st, en); return affixes(a).some(p => t.startsWith(needStr(p, 'startswith first arg'))); };
S.endswith = (s, a) => { const st = clampIdx(a[1], s.length, 0), en = clampIdx(a[2], s.length, s.length); const t = s.slice(st, en); return affixes(a).some(p => t.endsWith(needStr(p, 'endswith first arg'))); };
S.isdigit = s => s.length > 0 && /^[0-9²³¹٠-٩]+$/.test(s);
S.isdecimal = s => s.length > 0 && /^\p{Nd}+$/u.test(s);
S.isnumeric = s => s.length > 0 && /^[\p{N}]+$/u.test(s);
S.isalpha = s => s.length > 0 && /^\p{L}+$/u.test(s);
S.isalnum = s => s.length > 0 && /^[\p{L}\p{N}]+$/u.test(s);
S.isspace = s => s.length > 0 && /^[\s\u0085]+$/.test(s);
S.isupper = s => /\p{Lu}/u.test(s) && s === s.toUpperCase();
S.islower = s => /\p{Ll}/u.test(s) && s === s.toLowerCase();
S.istitle = s => s.length > 0 && /\p{L}/u.test(s) && S.title(s) === s;
S.title = s => s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
S.capitalize = s => s.length ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
S.swapcase = s => Array.from(s).map(c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()).join('');
S.casefold = s => s.toLowerCase();
S.center = (s, a) => pad(s, a[0], a[1], 'c');
S.ljust = (s, a) => pad(s, a[0], a[1], 'l');
S.rjust = (s, a) => pad(s, a[0], a[1], 'r');
S.zfill = (s, a) => { const w = Number(toBig(a[0])); if (strLen(s) >= w) return s; const sg = /^[+-]/.test(s) ? s[0] : ''; return sg + '0'.repeat(w - strLen(s)) + s.slice(sg.length); };
S.format = (s, a, kw) => strFormat(s, a, kw);
S.partition = (s, a) => { const k = s.indexOf(a[0]); return k < 0 ? new PyTuple([s, '', '']) : new PyTuple([s.slice(0, k), a[0], s.slice(k + a[0].length)]); };
S.rpartition = (s, a) => { const k = s.lastIndexOf(a[0]); return k < 0 ? new PyTuple(['', '', s]) : new PyTuple([s.slice(0, k), a[0], s.slice(k + a[0].length)]); };
S.removeprefix = (s, a) => s.startsWith(a[0]) ? s.slice(a[0].length) : s;
S.removesuffix = (s, a) => a[0] !== '' && s.endsWith(a[0]) ? s.slice(0, s.length - a[0].length) : s;
S.expandtabs = (s, a) => { const n = a.length ? Number(a[0]) : 8; let col = 0, out = ''; for (const c of s) { if (c === '\t') { const k = n - (col % n); out += ' '.repeat(k); col += k; } else { out += c; col = c === '\n' || c === '\r' ? 0 : col + 1; } } return out; };

const L = METHODS.list;
L.append = (l, a) => { argn('append', a, 1, 1); l.push(a[0]); return null; };
L.extend = (l, a) => { const it = toArray(a[0]); for (const x of it) l.push(x); return null; };
L.insert = (l, a) => { let k = Number(idxBig(a[0], 'list')); if (k < 0) { k += l.length; if (k < 0) k = 0; } if (k > l.length) k = l.length; l.splice(k, 0, a[1]); return null; };
L.pop = (l, a) => { if (!l.length) raise('IndexError', 'pop from empty list'); if (!a.length) return l.pop(); const k = normIdx(a[0], l.length, 'pop'); return l.splice(k, 1)[0]; };
L.remove = (l, a) => { for (let i = 0; i < l.length; i++) if (eq(l[i], a[0])) { l.splice(i, 1); return null; } raise('ValueError', 'list.remove(x): x not in list'); };
function seqIndex(arr, a, what) {
  const st = clampIdx(a[1], arr.length, 0), en = clampIdx(a[2], arr.length, arr.length);
  for (let i = st; i < en; i++) if (eq(arr[i], a[0])) return BigInt(i);
  raise('ValueError', pyRepr(a[0]) + ' is not in ' + what);
}
L.index = (l, a) => seqIndex(l, a, 'list');
L.count = (l, a) => BigInt(l.filter(x => eq(x, a[0])).length);
L.reverse = l => { l.reverse(); return null; };
L.copy = l => l.slice();
L.clear = l => { l.length = 0; return null; };
function sortArr(arr, key, reverse) {
  const items = key === null || key === undefined ? arr.map(x => [x, x]) : arr.map(x => [callValue(key, [x]), x]);
  const cmp = reverse ? (p, q) => (ltStrict(q[0], p[0]) ? -1 : ltStrict(p[0], q[0]) ? 1 : 0)
    : (p, q) => (ltStrict(p[0], q[0]) ? -1 : ltStrict(q[0], p[0]) ? 1 : 0);
  items.sort(cmp);
  return items.map(p => p[1]);
}
L.sort = (l, a, kw) => {
  if (a.length) raise('TypeError', 'sort() takes no positional arguments');
  const r = sortArr(l, kw.key, kw.reverse !== undefined && truthy(kw.reverse));
  for (let i = 0; i < r.length; i++) l[i] = r[i];
  return null;
};
METHODS.tuple.index = (t, a) => seqIndex(t.a, a, 'tuple');
METHODS.tuple.count = (t, a) => BigInt(t.a.filter(x => eq(x, a[0])).length);

const D = METHODS.dict;
D.get = (d, a) => { argn('get', a, 1, 2); const e = d.m.get(hk(a[0])); return e === undefined ? (a.length > 1 ? a[1] : null) : e[1]; };
D.keys = d => new PyView(d, 'keys');
D.values = d => new PyView(d, 'values');
D.items = d => new PyView(d, 'items');
D.pop = (d, a) => { const k = hk(a[0]); const e = d.m.get(k); if (e === undefined) { if (a.length > 1) return a[1]; throw new PyThrow(makeExc('KeyError', a[0])); } d.m.delete(k); return e[1]; };
D.popitem = d => { if (!d.m.size) raise('KeyError', 'popitem(): dictionary is empty'); const ks = Array.from(d.m.keys()); const k = ks[ks.length - 1]; const e = d.m.get(k); d.m.delete(k); return new PyTuple([e[0], e[1]]); };
D.setdefault = (d, a) => { const e = d.m.get(hk(a[0])); if (e !== undefined) return e[1]; const v = a.length > 1 ? a[1] : null; dictSet(d, a[0], v); return v; };
function dictUpdate(d, a, kw) {
  if (a.length) {
    const src = a[0];
    if (src instanceof PyDict) for (const e of Array.from(src.m.values())) dictSet(d, e[0], e[1]);
    else for (const p of toArray(src)) { const kv = toArray(p); if (kv.length !== 2) raise('ValueError', 'dictionary update sequence element has wrong length'); dictSet(d, kv[0], kv[1]); }
  }
  if (kw) for (const k of Object.keys(kw)) dictSet(d, k, kw[k]);
}
D.update = (d, a, kw) => { dictUpdate(d, a, kw); return null; };
D.copy = d => { const r = new PyDict(); for (const [k, e] of d.m) r.m.set(k, [e[0], e[1]]); return r; };
D.clear = d => { d.m.clear(); return null; };

const ST = METHODS.set;
ST.add = (s, a) => { s.m.set(hk(a[0]), [a[0], null]); return null; };
ST.remove = (s, a) => { if (!s.m.delete(hk(a[0]))) throw new PyThrow(makeExc('KeyError', a[0])); return null; };
ST.discard = (s, a) => { s.m.delete(hk(a[0])); return null; };
ST.pop = s => { if (!s.m.size) raise('KeyError', 'pop from an empty set'); const k = s.m.keys().next().value; const e = s.m.get(k); s.m.delete(k); return e[0]; };
ST.clear = s => { s.m.clear(); return null; };
ST.copy = s => makeSet(s);
const setArg = v => v instanceof PySet ? v : makeSet(v);
ST.union = (s, a) => a.reduce((acc, x) => setOp('|', acc, setArg(x)), makeSet(s));
ST.intersection = (s, a) => a.reduce((acc, x) => setOp('&', acc, setArg(x)), makeSet(s));
ST.difference = (s, a) => a.reduce((acc, x) => setOp('-', acc, setArg(x)), makeSet(s));
ST.symmetric_difference = (s, a) => setOp('^', s, setArg(a[0]));
ST.update = (s, a) => { for (const x of a) for (const e of Array.from(setArg(x).m.values())) s.m.set(hk(e[0]), [e[0], null]); return null; };
ST.issubset = (s, a) => { const o = setArg(a[0]); for (const k of s.m.keys()) if (!o.m.has(k)) return false; return true; };
ST.issuperset = (s, a) => { const o = setArg(a[0]); for (const k of o.m.keys()) if (!s.m.has(k)) return false; return true; };
ST.isdisjoint = (s, a) => { const o = setArg(a[0]); for (const k of s.m.keys()) if (o.m.has(k)) return false; return true; };

METHODS.int.bit_length = (n) => BigInt(toBig(n) === 0n ? 0 : bitLen(toBig(n) < 0n ? -toBig(n) : toBig(n)));
METHODS.bool.bit_length = METHODS.int.bit_length;
METHODS.float.is_integer = x => Number.isInteger(x);
METHODS.range.index = (r, a) => seqIndex(toArray(r), a, 'range');
METHODS.range.count = (r, a) => BigInt(toArray(r).filter(x => eq(x, a[0])).length);

/* ===================== TIPI PREDEFINITI ===================== */
const TYPES = {};
const BUILTINS = new Map();
function defType(name, fn) { const t = new PyBuiltin(name, fn, name); TYPES[name] = t; BUILTINS.set(name, t); return t; }
function defFn(name, fn) { BUILTINS.set(name, new PyBuiltin(name, fn)); }
function typeOf(v) {
  if (v instanceof PyObj) return v.cls;
  if (v instanceof PyClass) return TYPES.type;
  const t = TYPES[typeName(v)];
  return t || TYPES.object || C_object;
}
function parseIntStr(s, base) {
  const orig = s;
  let t = s.trim().replace(/_/g, m => m);
  let neg = false;
  if (/^[+-]/.test(t)) { neg = t[0] === '-'; t = t.slice(1); }
  let b = base;
  if (b === 0 || b === 16 || b === 8 || b === 2) {
    const m = /^0([xXoObB])/.exec(t);
    if (m) { const pb = { x: 16, o: 8, b: 2 }[m[1].toLowerCase()]; if (b === 0 || b === pb) { b = pb; t = t.slice(2); } }
  }
  if (b === 0) b = 10;
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, b);
  if (/(^_|_$|__)/.test(t)) t = '!';
  t = t.replace(/_/g, '').toLowerCase();
  if (!t.length || Array.from(t).some(c => digits.indexOf(c) < 0)) raise('ValueError', 'invalid literal for int() with base ' + base + ': ' + pyRepr(orig));
  let v = 0n; const bb = BigInt(b);
  for (const c of t) v = v * bb + BigInt(digits.indexOf(c));
  return neg ? -v : v;
}
function parseFloatStr(s) {
  const t = s.trim().toLowerCase().replace(/(\d)_(?=\d)/g, '$1');
  if (/^[+-]?(inf|infinity)$/.test(t)) return t[0] === '-' ? -Infinity : Infinity;
  if (/^[+-]?nan$/.test(t)) return NaN;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(t)) raise('ValueError', 'could not convert string to float: ' + pyRepr(s));
  return Number(t);
}
defType('int', (a, kw) => {
  if (!a.length) return 0n;
  const v = a[0], base = a.length > 1 ? Number(toBig(a[1])) : (kw && kw.base !== undefined ? Number(toBig(kw.base)) : null);
  if (typeof v === 'string') return parseIntStr(v, base === null ? 10 : base);
  if (base !== null) raise('TypeError', "int() can't convert non-string with explicit base");
  if (isInt(v)) return toBig(v);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) raise('ValueError', 'cannot convert float NaN to integer');
    if (!isFinite(v)) raise('OverflowError', 'cannot convert float infinity to integer');
    return BigInt(Math.trunc(v));
  }
  if (v instanceof PyObj) { const m = findAttr(v.cls, '__int__'); if (m !== undefined) return callValue(m, [v]); }
  raise('TypeError', "int() argument must be a string, a bytes-like object or a real number, not '" + typeName(v) + "'");
});
defType('float', a => {
  if (!a.length) return 0;
  const v = a[0];
  if (typeof v === 'string') return parseFloatStr(v);
  if (isNum(v)) return toF(v);
  if (v instanceof PyObj) { const m = findAttr(v.cls, '__float__'); if (m !== undefined) return callValue(m, [v]); }
  raise('TypeError', "float() argument must be a string or a real number, not '" + typeName(v) + "'");
});
defType('str', a => a.length ? pyStr(a[0]) : '');
defType('bool', a => a.length ? truthy(a[0]) : false);
defType('list', a => a.length ? toArray(a[0]) : []);
defType('tuple', a => new PyTuple(a.length ? toArray(a[0]) : []));
defType('set', a => makeSet(a.length ? a[0] : undefined));
defType('frozenset', a => makeSet(a.length ? a[0] : undefined));
defType('dict', (a, kw) => { const d = new PyDict(); dictUpdate(d, a, kw); return d; });
defType('range', a => {
  argn('range', a, 1, 3);
  const g = x => { if (!isInt(x)) raise('TypeError', "'" + typeName(x) + "' object cannot be interpreted as an integer"); return toBig(x); };
  if (a.length === 1) return new PyRange(0n, g(a[0]), 1n);
  const step = a.length > 2 ? g(a[2]) : 1n;
  if (step === 0n) raise('ValueError', 'range() arg 3 must not be zero');
  return new PyRange(g(a[0]), g(a[1]), step);
});
defType('type', a => {
  if (a.length === 1) return typeOf(a[0]);
  raise('TypeError', 'type() con 3 argomenti non è supportato in questo editor');
});
TYPES.object = C_object; BUILTINS.set('object', C_object);
TYPES.NoneType = new PyBuiltin('NoneType', () => null, 'NoneType');
TYPES.function = new PyBuiltin('function', () => null, 'function');
for (const k of Object.keys(EXC)) BUILTINS.set(k, EXC[k]);
BUILTINS.set('property', new PyBuiltin('property', (a, kw) => new PyProperty(a[0] || null, a[1] || null), 'property'));
BUILTINS.set('staticmethod', new PyBuiltin('staticmethod', a => new PyStatic(a[0]), 'staticmethod'));
BUILTINS.set('classmethod', new PyBuiltin('classmethod', a => new PyClassMethod(a[0]), 'classmethod'));

function isInstance(v, cls) {
  if (cls instanceof PyTuple) return cls.a.some(c => isInstance(v, c));
  if (cls instanceof PyClass) { if (cls === C_object) return true; return v instanceof PyObj && isSubclass(v.cls, cls); }
  if (cls instanceof PyBuiltin && cls.tname) {
    switch (cls.tname) {
      case 'int': return isInt(v);
      case 'float': return typeof v === 'number';
      case 'bool': return typeof v === 'boolean';
      case 'str': return typeof v === 'string';
      case 'list': return Array.isArray(v);
      case 'tuple': return v instanceof PyTuple;
      case 'dict': return v instanceof PyDict;
      case 'set': case 'frozenset': return v instanceof PySet;
      case 'range': return v instanceof PyRange;
      case 'type': return v instanceof PyClass || (v instanceof PyBuiltin && !!v.tname);
      case 'NoneType': return v === null;
      case 'function': return v instanceof PyFunction;
      default: return false;
    }
  }
  raise('TypeError', 'isinstance() arg 2 must be a type, a tuple of types, or a union');
}

/* ===================== FUNZIONI PREDEFINITE ===================== */
function kwOnly(kw, allowed, fname) {
  if (!kw) return;
  for (const k of Object.keys(kw)) if (allowed.indexOf(k) < 0) raise('TypeError', "'" + k + "' is an invalid keyword argument for " + fname + '()');
}
defFn('print', (a, kw) => {
  kwOnly(kw, ['sep', 'end', 'file', 'flush'], 'print');
  const sep = kw && kw.sep !== undefined && kw.sep !== null ? needStr(kw.sep, 'sep') : ' ';
  const end = kw && kw.end !== undefined && kw.end !== null ? needStr(kw.end, 'end') : '\n';
  ctxWrite(a.map(pyStr).join(sep) + end);
  return null;
});
defFn('input', a => {
  if (a.length) ctxWrite(pyStr(a[0]));
  if (!ctx.inputs.length) raise('EOFError', 'EOF when reading a line');
  const line = ctx.inputs.shift();
  if (ctx.echo) ctxWrite(line + '\n');
  return line;
});
defFn('len', a => {
  argn('len', a, 1, 1);
  const v = a[0];
  if (typeof v === 'string') return BigInt(strLen(v));
  if (Array.isArray(v)) return BigInt(v.length);
  if (v instanceof PyTuple) return BigInt(v.a.length);
  if (v instanceof PyDict || v instanceof PySet) return BigInt(v.m.size);
  if (v instanceof PyView) return BigInt(v.d.m.size);
  if (v instanceof PyRange) return rangeLen(v);
  if (v instanceof PyObj) { const m = findAttr(v.cls, '__len__'); if (m !== undefined) { const r = callValue(m, [v]); if (!isInt(r)) raise('TypeError', "'" + typeName(r) + "' object cannot be interpreted as an integer"); return toBig(r); } }
  raise('TypeError', "object of type '" + typeName(v) + "' has no len()");
});
defFn('abs', a => {
  argn('abs', a, 1, 1);
  const v = a[0];
  if (typeof v === 'bigint') return v < 0n ? -v : v;
  if (typeof v === 'boolean') return toBig(v);
  if (typeof v === 'number') return Math.abs(v);
  if (v instanceof PyObj) { const m = findAttr(v.cls, '__abs__'); if (m !== undefined) return callValue(m, [v]); }
  raise('TypeError', "bad operand type for abs(): '" + typeName(v) + "'");
});
function minmax(name, a, kw, wantMax) {
  kwOnly(kw, ['key', 'default'], name);
  let items;
  if (a.length === 1) items = toArray(a[0]);
  else if (a.length === 0) raise('TypeError', name + ' expected at least 1 argument, got 0');
  else items = a;
  if (!items.length) {
    if (kw && kw.default !== undefined) return kw.default;
    raise('ValueError', name + '() iterable argument is empty');
  }
  const key = kw && kw.key !== undefined && kw.key !== null ? kw.key : null;
  let best = items[0], bk = key ? callValue(key, [best]) : best;
  for (let i = 1; i < items.length; i++) {
    const k = key ? callValue(key, [items[i]]) : items[i];
    if (wantMax ? ordered('>', k, bk) : ordered('<', k, bk)) { best = items[i]; bk = k; }
  }
  return best;
}
defFn('min', (a, kw) => minmax('min', a, kw, false));
defFn('max', (a, kw) => minmax('max', a, kw, true));
defFn('sum', (a, kw) => {
  argn('sum', a, 1, 2);
  const start = a.length > 1 ? a[1] : (kw && kw.start !== undefined ? kw.start : undefined);
  if (typeof start === 'string') raise('TypeError', "sum() can't sum strings [use ''.join(seq) instead]");
  return pySum(a[0], start);
});
defFn('sorted', (a, kw) => { kwOnly(kw, ['key', 'reverse'], 'sorted'); argn('sorted', a, 1, 1); return sortArr(toArray(a[0]), kw ? kw.key : null, kw && kw.reverse !== undefined && truthy(kw.reverse)); });
defFn('reversed', a => {
  const v = a[0];
  if (v instanceof PyObj) { const m = findAttr(v.cls, '__reversed__'); if (m !== undefined) return callValue(m, [v]); }
  if (v instanceof PySet || v instanceof PyDict && false) raise('TypeError', "'" + typeName(v) + "' object is not reversible");
  const arr = toArray(v); let i = arr.length;
  return new PyIter(() => i > 0 ? arr[--i] : DONE, 'reversed');
});
defFn('enumerate', (a, kw) => {
  const nx = getIter(a[0]); let i = a.length > 1 ? toBig(a[1]) : (kw && kw.start !== undefined ? toBig(kw.start) : 0n);
  return new PyIter(() => { const x = nx(); return x === DONE ? DONE : new PyTuple([i++, x]); }, 'enumerate');
});
defFn('zip', (a, kw) => {
  if (!a.length) return new PyIter(() => DONE, 'zip');
  const its = a.map(getIter);
  return new PyIter(() => { const row = []; for (const nx of its) { const x = nx(); if (x === DONE) return DONE; row.push(x); } return new PyTuple(row); }, 'zip');
});
defFn('map', a => {
  const f = a[0], its = a.slice(1).map(getIter);
  return new PyIter(() => { const row = []; for (const nx of its) { const x = nx(); if (x === DONE) return DONE; row.push(x); } return callValue(f, row); }, 'map');
});
defFn('filter', a => {
  const f = a[0], nx = getIter(a[1]);
  return new PyIter(() => { for (;;) { const x = nx(); if (x === DONE) return DONE; if (f === null ? truthy(x) : truthy(callValue(f, [x]))) return x; } }, 'filter');
});
defFn('any', a => { const nx = getIter(a[0]); for (let x = nx(); x !== DONE; x = nx()) if (truthy(x)) return true; return false; });
defFn('all', a => { const nx = getIter(a[0]); for (let x = nx(); x !== DONE; x = nx()) if (!truthy(x)) return false; return true; });
defFn('round', (a, kw) => { argn('round', a, 1, 2); const nd = a.length > 1 ? a[1] : (kw ? kw.ndigits : undefined); if (!isNum(a[0])) { if (a[0] instanceof PyObj) { const m = findAttr(a[0].cls, '__round__'); if (m !== undefined) return callValue(m, [a[0]].concat(nd === undefined ? [] : [nd])); } raise('TypeError', "type " + typeName(a[0]) + " doesn't define __round__ method"); } return pyRound(a[0], nd); });
function modPow(b, e, m) { let r = 1n; b = modBig(b, m); while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; } return r; }
defFn('pow', (a, kw) => {
  argn('pow', a, 2, 3);
  if (a.length === 3 && a[2] !== null) {
    if (!isInt(a[0]) || !isInt(a[1]) || !isInt(a[2])) raise('TypeError', 'pow() 3rd argument not allowed unless all arguments are integers');
    const m = toBig(a[2]); if (m === 0n) raise('ValueError', 'pow() 3rd argument cannot be 0');
    let e = toBig(a[1]);
    if (e < 0n) raise('ValueError', 'esponenti negativi con modulo non sono supportati in questo editor');
    const r = modPow(toBig(a[0]), e, m < 0n ? -m : m);
    return m < 0n && r !== 0n ? r + m : r;
  }
  return binop('**', a[0], a[1]);
});
defFn('divmod', a => { argn('divmod', a, 2, 2); return new PyTuple([binop('//', a[0], a[1]), binop('%', a[0], a[1])]); });
defFn('isinstance', a => { argn('isinstance', a, 2, 2); return isInstance(a[0], a[1]); });
defFn('issubclass', a => {
  const test = (c, k) => { if (k instanceof PyTuple) return k.a.some(x => test(c, x)); if (c instanceof PyClass && k instanceof PyClass) return isSubclass(c, k); if (c instanceof PyBuiltin && k instanceof PyBuiltin) return c === k || (c.tname === 'bool' && k.tname === 'int'); if (k === C_object) return true; return false; };
  return test(a[0], a[1]);
});
defFn('repr', a => { argn('repr', a, 1, 1); return pyRepr(a[0]); });
defFn('ascii', a => pyRepr(a[0]).replace(/[^\x00-\x7f]/g, c => { const n = c.codePointAt(0); return n < 256 ? '\\x' + n.toString(16).padStart(2, '0') : n < 65536 ? '\\u' + n.toString(16).padStart(4, '0') : '\\U' + n.toString(16).padStart(8, '0'); }));
defFn('ord', a => { if (typeof a[0] !== 'string' || strLen(a[0]) !== 1) raise('TypeError', 'ord() expected a character, but string of length ' + (typeof a[0] === 'string' ? strLen(a[0]) : 1) + ' found'); return BigInt(a[0].codePointAt(0)); });
defFn('chr', a => { if (!isInt(a[0])) raise('TypeError', "'" + typeName(a[0]) + "' object cannot be interpreted as an integer"); const n = Number(toBig(a[0])); if (n < 0 || n > 0x10ffff) raise('ValueError', 'chr() arg not in range(0x110000)'); return String.fromCodePoint(n); });
function baseStr(v, b, prefix) {
  if (!isInt(v)) raise('TypeError', "'" + typeName(v) + "' object cannot be interpreted as an integer");
  const n = toBig(v); return (n < 0n ? '-' : '') + prefix + (n < 0n ? -n : n).toString(b);
}
defFn('bin', a => baseStr(a[0], 2, '0b'));
defFn('oct', a => baseStr(a[0], 8, '0o'));
defFn('hex', a => baseStr(a[0], 16, '0x'));
defFn('id', a => BigInt(typeof a[0] === 'object' && a[0] !== null || typeof a[0] === 'function' ? 0x7f3a2c000000 + objId(a[0]) * 48 : 0x1000 + Number(hk(a[0]).length)));
defFn('hash', a => { const v = a[0]; if (isInt(v)) return toBig(v); if (typeof v === 'number') return Number.isInteger(v) ? BigInt(v) : BigInt(Math.floor(v * 1000003) | 0); const k = hk(v); let h = 0; for (let i = 0; i < k.length; i++) h = (h * 31 + k.charCodeAt(i)) | 0; return BigInt(h); });
defFn('callable', a => isCallable(a[0]));
defFn('iter', a => { if (a[0] instanceof PyIter) return a[0]; return new PyIter(getIter(a[0]), 'iterator'); });
defFn('next', a => {
  const it = a[0];
  let r;
  if (it instanceof PyIter) r = it.nx();
  else if (it instanceof PyObj && findAttr(it.cls, '__next__') !== undefined) {
    try { r = callValue(findAttr(it.cls, '__next__'), [it]); } catch (e) { if (e instanceof PyThrow && isSubclass(e.obj.cls, EXC.StopIteration)) r = DONE; else throw e; }
  } else raise('TypeError', "'" + typeName(it) + "' object is not an iterator");
  if (r === DONE) { if (a.length > 1) return a[1]; raise('StopIteration'); }
  return r;
});
defFn('getattr', a => {
  argn('getattr', a, 2, 3);
  try { return getAttr(a[0], needStr(a[1], 'getattr(): attribute name')); }
  catch (e) { if (a.length > 2 && e instanceof PyThrow && isSubclass(e.obj.cls, EXC.AttributeError)) return a[2]; throw e; }
});
defFn('hasattr', a => { try { getAttr(a[0], needStr(a[1], 'hasattr(): attribute name')); return true; } catch (e) { if (e instanceof PyThrow && isSubclass(e.obj.cls, EXC.AttributeError)) return false; throw e; } });
defFn('setattr', a => { setAttr(a[0], a[1], a[2]); return null; });
defFn('delattr', a => { if (a[0] instanceof PyObj) { if (!a[0].d.delete(a[1])) noAttr(a[0], a[1]); return null; } noAttr(a[0], a[1]); });
defFn('format', a => formatValue(a[0], a.length > 1 ? a[1] : ''));
defFn('vars', a => { const d = new PyDict(); if (a[0] instanceof PyObj) for (const [k, v] of a[0].d) dictSet(d, k, v); return d; });
defFn('dir', a => { const names = new Set(); const o = a[0]; if (o instanceof PyObj) { for (const k of o.d.keys()) names.add(k); for (const c of o.cls.mro) for (const k of c.d.keys()) names.add(k); } else if (o instanceof PyClass) { for (const c of o.mro) for (const k of c.d.keys()) names.add(k); } else if (METHODS[typeName(o)]) for (const k of Object.keys(METHODS[typeName(o)])) names.add(k); return Array.from(names).sort(); });
defFn('globals', () => { const d = new PyDict(); for (const [k, v] of ctx.globals.v) dictSet(d, k, v); return d; });
defFn('exit', () => { throw new PyAbort('exit', 'Programma terminato con exit()'); });
BUILTINS.set('quit', BUILTINS.get('exit'));
defFn('open', () => raise('OSError', 'i file non sono disponibili in questo editor'));
defFn('__import__', a => importModule(a[0]));

/* ===================== MODULI ===================== */
const MODULES = {};
function mkMod(name, defs) {
  const d = new Map();
  for (const k of Object.keys(defs)) {
    const v = defs[k];
    d.set(k, typeof v === 'function' ? new PyBuiltin(k, v) : v);
  }
  MODULES[name] = new PyModule(name, d);
}
const domErr = () => raise('ValueError', 'math domain error');
const f1 = (name, fn, check) => (a) => {
  argn(name, a, 1, 1);
  if (!isNum(a[0])) raise('TypeError', 'must be real number, not ' + typeName(a[0]));
  const x = toF(a[0]);
  if (check && !check(x)) domErr();
  return fn(x);
};
function intResult(x, what) {
  if (Number.isNaN(x)) raise('ValueError', 'cannot convert float NaN to integer');
  if (!isFinite(x)) raise('OverflowError', 'cannot convert float infinity to integer');
  return BigInt(x);
}
function gcdBig(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) { [a, b] = [b, a % b]; } return a; }
function gammaLn(x) {
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - gammaLn(1 - x);
  x -= 1; let s = c[0]; const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) s += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(s);
}
function erfFn(x) {
  // Abramowitz-Stegun 7.1.26 raffinata con serie/frazione continua
  const ax = Math.abs(x);
  if (ax < 2.5) {
    let sum = ax, term = ax, n = 0;
    while (Math.abs(term) > 1e-17 * Math.abs(sum) && n < 200) { n++; term *= -ax * ax / n; sum += term / (2 * n + 1); }
    const r = 2 / Math.sqrt(Math.PI) * sum;
    return x < 0 ? -r : r;
  }
  let f = 0; for (let k = 60; k >= 1; k--) f = k / 2 / (ax + f);
  const r = 1 - Math.exp(-ax * ax) / Math.sqrt(Math.PI) / (ax + f);
  return x < 0 ? -r : r;
}
mkMod('math', {
  pi: Math.PI, e: Math.E, tau: 2 * Math.PI, inf: Infinity, nan: NaN,
  sqrt: f1('sqrt', Math.sqrt, x => !(x < 0)),
  exp: f1('exp', Math.exp),
  log: (a) => {
    argn('log', a, 1, 2);
    const lg = x => { if (isInt(x) && toBig(x) > 0n && toBig(x) > 9007199254740991n) { const b = toBig(x).toString(2).length - 60; return Math.log(Number(toBig(x) >> BigInt(b))) + b * Math.LN2; } const y = toF(x); if (!(y > 0)) domErr(); return Math.log(y); };
    if (!isNum(a[0])) raise('TypeError', 'must be real number, not ' + typeName(a[0]));
    if (a.length === 1) return lg(a[0]);
    const d = lg(a[1]); if (d === 0) raise('ZeroDivisionError', 'division by zero');
    return lg(a[0]) / d;
  },
  log10: f1('log10', Math.log10, x => x > 0), log2: f1('log2', Math.log2, x => x > 0), log1p: f1('log1p', Math.log1p, x => x > -1), expm1: f1('expm1', Math.expm1),
  sin: f1('sin', Math.sin, isFinite), cos: f1('cos', Math.cos, isFinite), tan: f1('tan', Math.tan, isFinite),
  asin: f1('asin', Math.asin, x => x >= -1 && x <= 1), acos: f1('acos', Math.acos, x => x >= -1 && x <= 1), atan: f1('atan', Math.atan),
  sinh: f1('sinh', Math.sinh), cosh: f1('cosh', Math.cosh), tanh: f1('tanh', Math.tanh), asinh: f1('asinh', Math.asinh), acosh: f1('acosh', Math.acosh, x => x >= 1), atanh: f1('atanh', Math.atanh, x => x > -1 && x < 1),
  atan2: a => Math.atan2(toF(a[0]), toF(a[1])),
  degrees: f1('degrees', x => x * 180 / Math.PI), radians: f1('radians', x => x * Math.PI / 180),
  fabs: f1('fabs', Math.abs),
  floor: a => { if (isInt(a[0])) return toBig(a[0]); return intResult(Math.floor(toF(a[0]))); },
  ceil: a => { if (isInt(a[0])) return toBig(a[0]); return intResult(Math.ceil(toF(a[0]))); },
  trunc: a => { if (isInt(a[0])) return toBig(a[0]); return intResult(Math.trunc(toF(a[0]))); },
  isnan: a => Number.isNaN(toF(a[0])), isinf: a => { const x = toF(a[0]); return x === Infinity || x === -Infinity; }, isfinite: a => isFinite(toF(a[0])),
  pow: a => { const x = toF(a[0]), y = toF(a[1]); if ((x === 0 && y < 0) || (x < 0 && !Number.isInteger(y) && isFinite(x) && isFinite(y))) domErr(); return Math.pow(x, y); },
  hypot: a => Math.hypot(...a.map(toF)),
  copysign: a => { const x = Math.abs(toF(a[0])), y = toF(a[1]); return (y < 0 || Object.is(y, -0)) ? -x : x; },
  fmod: a => { const y = toF(a[1]); if (y === 0) domErr(); return toF(a[0]) % y; },
  factorial: a => { if (!isInt(a[0])) raise('TypeError', "'" + typeName(a[0]) + "' object cannot be interpreted as an integer"); const n = toBig(a[0]); if (n < 0n) raise('ValueError', 'factorial() not defined for negative values'); if (n > 5000n) raise('OverflowError', 'factorial() troppo grande per questo editor'); let r = 1n; for (let i = 2n; i <= n; i++) r *= i; return r; },
  gcd: a => a.reduce((acc, x) => gcdBig(acc, toBig(x)), 0n),
  lcm: a => a.reduce((acc, x) => { const y = toBig(x); if (acc === 0n || y === 0n) return 0n; const r = acc * y / gcdBig(acc, y); return r < 0n ? -r : r; }, 1n),
  comb: a => { const n = toBig(a[0]), k = toBig(a[1]); if (n < 0n || k < 0n) raise('ValueError', 'n and k must be non-negative integers'); if (k > n) return 0n; let r = 1n; const kk = k > n - k ? n - k : k; for (let i = 1n; i <= kk; i++) r = r * (n - kk + i) / i; return r; },
  perm: a => { const n = toBig(a[0]); const k = a.length > 1 && a[1] !== null ? toBig(a[1]) : n; if (n < 0n || k < 0n) raise('ValueError', 'n and k must be non-negative integers'); if (k > n) return 0n; let r = 1n; for (let i = 0n; i < k; i++) r *= (n - i); return r; },
  prod: (a, kw) => { let r = kw && kw.start !== undefined ? kw.start : 1n; for (const x of toArray(a[0])) r = binop('*', r, x); return r; },
  fsum: a => { const items = toArray(a[0]).map(x => { if (!isNum(x)) raise('TypeError', "must be real number, not " + typeName(x)); return x; }); if (items.some(x => typeof x === 'number' && !isFinite(x))) return items.reduce((s, x) => s + toF(x), 0); const { X, P } = scaledInts(items); return ratioToNumber(X.reduce((s, x) => s + x, 0n), 1n << BigInt(P)); },
  isclose: (a, kw) => { const x = toF(a[0]), y = toF(a[1]); const rt = kw && kw.rel_tol !== undefined ? toF(kw.rel_tol) : 1e-9, at = kw && kw.abs_tol !== undefined ? toF(kw.abs_tol) : 0; if (x === y) return true; if (!isFinite(x) || !isFinite(y)) return false; const d = Math.abs(x - y); return d <= Math.abs(rt * y) || d <= Math.abs(rt * x) || d <= at; },
  isqrt: a => { const n = toBig(a[0]); if (n < 0n) raise('ValueError', 'isqrt() argument must be nonnegative'); return isqrtBig(n); },
  erf: f1('erf', erfFn), erfc: f1('erfc', x => 1 - erfFn(x)),
  gamma: f1('gamma', x => { if (Number.isInteger(x)) { if (x <= 0) domErr(); let r = 1; for (let i = 2; i < x; i++) r *= i; return r; } if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * Math.exp(gammaLn(1 - x))); return Math.exp(gammaLn(x)); }),
  lgamma: f1('lgamma', x => { if (Number.isInteger(x) && x <= 0) return Infinity; return gammaLn(x); }),
});

/* random: generatore xorshift128+ con seme; NON riproduce i numeri di CPython */
let rngS = [0x9e3779b9, 0x243f6a88, 0xb7e15162, 0xdeadbeef];
function rngSeed(seed) {
  let h = 1779033703 ^ seed;
  for (let i = 0; i < 4; i++) {
    h = Math.imul(h ^ (h >>> 16), 2246822507); h = Math.imul(h ^ (h >>> 13), 3266489909); h ^= h >>> 16;
    rngS[i] = (h + i * 0x9e3779b9) | 0;
  }
  for (let i = 0; i < 20; i++) rngU32();
}
function rngU32() {
  let t = rngS[3];
  const s = rngS[0];
  rngS[3] = rngS[2]; rngS[2] = rngS[1]; rngS[1] = s;
  t ^= t << 11; t ^= t >>> 8;
  rngS[0] = t ^ s ^ (s >>> 19);
  return rngS[0] >>> 0;
}
function rnd() { return ((rngU32() >>> 5) * 67108864 + (rngU32() >>> 6)) / 9007199254740992; }
function randBelow(n) { return Math.floor(rnd() * n); }
function seedFrom(v) {
  if (v === null || v === undefined) return (Date.now() ^ (Math.random() * 4294967296)) | 0;
  if (isInt(v)) return Number(BigInt.asIntN(32, toBig(v)));
  if (typeof v === 'number') return Math.floor(v) | 0;
  const k = hk(v); let h = 0; for (let i = 0; i < k.length; i++) h = (Math.imul(h, 31) + k.charCodeAt(i)) | 0; return h;
}
rngSeed(seedFrom(null));
let gaussNext = null;
mkMod('random', {
  seed: a => { rngSeed(seedFrom(a.length ? a[0] : null)); gaussNext = null; return null; },
  random: () => rnd(),
  randint: a => { const lo = toBig(a[0]), hi = toBig(a[1]); if (hi < lo) raise('ValueError', 'empty range in randrange(' + lo + ', ' + (hi + 1n) + ')'); return lo + BigInt(randBelow(Number(hi - lo + 1n))); },
  randrange: a => { let lo = 0n, hi, st = 1n; if (a.length === 1) hi = toBig(a[0]); else { lo = toBig(a[0]); hi = toBig(a[1]); if (a.length > 2) st = toBig(a[2]); } if (st === 0n) raise('ValueError', 'zero step for randrange()'); const n = rangeLen(new PyRange(lo, hi, st)); if (n <= 0n) raise('ValueError', 'empty range in randrange(' + lo + ', ' + hi + ')'); return lo + BigInt(randBelow(Number(n))) * st; },
  uniform: a => { const x = toF(a[0]), y = toF(a[1]); return x + (y - x) * rnd(); },
  choice: a => { const s = toArray(a[0]); if (!s.length) raise('IndexError', 'Cannot choose from an empty sequence'); return s[randBelow(s.length)]; },
  choices: (a, kw) => {
    const pop = toArray(a[0]); const k = kw && kw.k !== undefined ? Number(toBig(kw.k)) : 1; const out = [];
    if (kw && kw.weights !== undefined && kw.weights !== null) {
      const w = toArray(kw.weights).map(toF); const tot = w.reduce((s, x) => s + x, 0);
      for (let i = 0; i < k; i++) { let r = rnd() * tot, j = 0; while (j < w.length - 1 && r >= w[j]) { r -= w[j]; j++; } out.push(pop[j]); }
    } else for (let i = 0; i < k; i++) out.push(pop[randBelow(pop.length)]);
    return out;
  },
  shuffle: a => { const l = a[0]; if (!Array.isArray(l)) raise('TypeError', 'shuffle richiede una lista'); for (let i = l.length - 1; i > 0; i--) { const j = randBelow(i + 1); [l[i], l[j]] = [l[j], l[i]]; } return null; },
  sample: (a, kw) => { const pop = toArray(a[0]); const k = Number(toBig(a.length > 1 ? a[1] : kw.k)); if (k < 0 || k > pop.length) raise('ValueError', 'Sample larger than population or is negative'); const idx = pop.map((_, i) => i); for (let i = idx.length - 1; i > 0; i--) { const j = randBelow(i + 1); [idx[i], idx[j]] = [idx[j], idx[i]]; } return idx.slice(0, k).map(i => pop[i]); },
  gauss: a => { const mu = a.length ? toF(a[0]) : 0, sg = a.length > 1 ? toF(a[1]) : 1; let z = gaussNext; gaussNext = null; if (z === null) { const x2 = rnd() * 2 * Math.PI, g2 = Math.sqrt(-2 * Math.log(1 - rnd())); z = Math.cos(x2) * g2; gaussNext = Math.sin(x2) * g2; } return mu + z * sg; },
  normalvariate: a => MODULES.random.d.get('gauss').fn(a),
  triangular: a => { const lo = a.length ? toF(a[0]) : 0, hi = a.length > 1 ? toF(a[1]) : 1; const m = a.length > 2 && a[2] !== null ? toF(a[2]) : (lo + hi) / 2; const u = rnd(), c = (m - lo) / (hi - lo); return u < c ? lo + Math.sqrt(u * (hi - lo) * (m - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - m)); },
  expovariate: a => -Math.log(1 - rnd()) / toF(a[0]),
});

/* time */
mkMod('time', {
  time: () => Date.now() / 1000,
  perf_counter: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000,
  monotonic: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000,
  sleep: a => { const s = toF(a[0]); if (s < 0) raise('ValueError', 'sleep length must be non-negative'); ctx.slept = (ctx.slept || 0) + s; const end = Date.now() + Math.min(s, 0.2) * 1000; while (Date.now() < end) { /* attesa breve */ } return null; },
});

/* copy */
function deepCopy(v, memo) {
  if (v === null || typeof v !== 'object') return v;
  if (memo.has(v)) return memo.get(v);
  let r;
  if (Array.isArray(v)) { r = []; memo.set(v, r); for (const x of v) r.push(deepCopy(x, memo)); }
  else if (v instanceof PyTuple) { r = new PyTuple(v.a.map(x => deepCopy(x, memo))); memo.set(v, r); }
  else if (v instanceof PyDict) { r = new PyDict(); memo.set(v, r); for (const [k, e] of v.m) r.m.set(k, [deepCopy(e[0], memo), deepCopy(e[1], memo)]); }
  else if (v instanceof PySet) { r = new PySet(); memo.set(v, r); for (const [k, e] of v.m) r.m.set(k, [deepCopy(e[0], memo), null]); }
  else if (v instanceof PyObj) { r = new PyObj(v.cls); memo.set(v, r); for (const [k, x] of v.d) r.d.set(k, deepCopy(x, memo)); }
  else r = v;
  return r;
}
function shallowCopy(v) {
  if (Array.isArray(v)) return v.slice();
  if (v instanceof PyDict) return D.copy(v);
  if (v instanceof PySet) return makeSet(v);
  if (v instanceof PyObj) { const r = new PyObj(v.cls); for (const [k, x] of v.d) r.d.set(k, x); return r; }
  return v;
}
mkMod('copy', { copy: a => shallowCopy(a[0]), deepcopy: a => deepCopy(a[0], new Map()) });

/* statistics */
function statErr(msg) { raise('StatisticsError', msg); }
function statData(a, need, fname) {
  const d = numList(a[0], fname);
  if (d.length < need) statErr(need === 1 ? 'no mean/median/mode of empty data'.replace('mean/median/mode', fname === 'mean' ? 'mean' : fname) : (fname + ' requires at least ' + need + ' data points'));
  return d;
}
const allInts = d => d.every(isInt);
const hasNonFinite = d => d.some(x => typeof x === 'number' && !isFinite(x));
function exactMean(d) {
  const n = BigInt(d.length);
  if (hasNonFinite(d)) return d.reduce((s, x) => s + toF(x), 0) / d.length;
  const { X, P } = scaledInts(d);
  const S0 = X.reduce((s, x) => s + x, 0n);
  if (allInts(d)) { return S0 % n === 0n ? S0 / n : ratioToNumber(S0, n); }
  return ratioToNumber(S0, n << BigInt(P));
}
function exactVar(d, sample) {
  const n = BigInt(d.length);
  if (hasNonFinite(d)) return NaN;
  const { X, P } = scaledInts(d);
  const S0 = X.reduce((s, x) => s + x, 0n), Q = X.reduce((s, x) => s + x * x, 0n);
  const num = n * Q - S0 * S0;
  const den = (sample ? n * (n - 1n) : n * n) << BigInt(2 * P);
  return { num, den };
}
function varResult(d, sample, isStd) {
  const r = exactVar(d, sample);
  if (typeof r === 'number') return r;
  if (isStd) return sqrtFrac(r.num, r.den);
  if (allInts(d) && r.num % r.den === 0n) return r.num / r.den;
  return ratioToNumber(r.num, r.den);
}
function fsumF(arr) { const { X, P } = scaledInts(arr); return ratioToNumber(X.reduce((s, x) => s + x, 0n), 1n << BigInt(P)); }
function sortedNums(d) { return sortArr(d, null, false); }
mkMod('statistics', {
  mean: a => exactMean(statData(a, 1, 'mean')),
  fmean: a => { const d = statData(a, 1, 'fmean'); return hasNonFinite(d) ? d.reduce((s, x) => s + toF(x), 0) / d.length : fsumF(d) / d.length; },
  median: a => { const d = sortedNums(statData(a, 1, 'median')), n = d.length; return n % 2 ? d[(n - 1) / 2] : binop('/', binop('+', d[n / 2 - 1], d[n / 2]), 2n); },
  median_low: a => { const d = sortedNums(statData(a, 1, 'median_low')), n = d.length; return n % 2 ? d[(n - 1) / 2] : d[n / 2 - 1]; },
  median_high: a => { const d = sortedNums(statData(a, 1, 'median_high')); return d[Math.floor(d.length / 2)]; },
  mode: a => { const d = toArray(a[0]); if (!d.length) statErr('no mode for empty data'); const cnt = new Map(); for (const x of d) { const k = hk(x); const e = cnt.get(k); if (e) e[1]++; else cnt.set(k, [x, 1]); } let best = null, bc = 0; for (const [x, c] of cnt.values()) if (c > bc) { best = x; bc = c; } return best; },
  multimode: a => { const d = toArray(a[0]); const cnt = new Map(); for (const x of d) { const k = hk(x); const e = cnt.get(k); if (e) e[1]++; else cnt.set(k, [x, 1]); } let bc = 0; for (const [, c] of cnt.values()) if (c > bc) bc = c; return Array.from(cnt.values()).filter(e => e[1] === bc).map(e => e[0]); },
  variance: a => varResult(statData(a, 2, 'variance'), true, false),
  pvariance: a => varResult(statData(a, 1, 'pvariance'), false, false),
  stdev: a => varResult(statData(a, 2, 'stdev'), true, true),
  pstdev: a => varResult(statData(a, 1, 'pstdev'), false, true),
  quantiles: (a, kw) => {
    const d = sortedNums(numList(a[0], 'quantiles')); const n = kw && kw.n !== undefined ? Number(toBig(kw.n)) : 4; const inc = kw && kw.method === 'inclusive';
    if (n < 1) statErr('n must be at least 1'); if (d.length < (inc ? 1 : 2)) statErr('must have at least two data points');
    const ld = d.length, out = [];
    if (inc) { const m = ld - 1; for (let i = 1; i < n; i++) { const j = Math.floor(i * m / n), delta = i * m - j * n; out.push(binop('/', binop('+', binop('*', d[j], BigInt(n - delta)), binop('*', d[j + 1] === undefined ? d[j] : d[j + 1], BigInt(delta))), BigInt(n))); } }
    else { const m = ld + 1; for (let i = 1; i < n; i++) { let j = Math.floor(i * m / n); j = j < 1 ? 1 : j > ld - 1 ? ld - 1 : j; const delta = i * m - j * n; out.push(binop('/', binop('+', binop('*', d[j - 1], BigInt(n - delta)), binop('*', d[j], BigInt(delta))), BigInt(n))); } }
    return out;
  },
  correlation: a => {
    const x = numList(a[0], 'correlation').map(toF), y = numList(a[1], 'correlation').map(toF);
    if (x.length !== y.length) statErr('correlation requires that both inputs have same number of data points');
    if (x.length < 2) statErr('correlation requires at least two data points');
    const n = x.length, xb = fsumF(x) / n, yb = fsumF(y) / n;
    const sxy = fsumF(x.map((v, i) => (v - xb) * (y[i] - yb))), sxx = fsumF(x.map(v => (v - xb) ** 2)), syy = fsumF(y.map(v => (v - yb) ** 2));
    if (sxx === 0 || syy === 0) statErr('at least one of the inputs is constant');
    return sxy / Math.sqrt(sxx * syy);
  },
  covariance: a => {
    const x = numList(a[0], 'covariance').map(toF), y = numList(a[1], 'covariance').map(toF);
    if (x.length !== y.length) statErr('covariance requires that both inputs have same number of data points');
    if (x.length < 2) statErr('covariance requires at least two data points');
    const n = x.length, xb = fsumF(x) / n, yb = fsumF(y) / n;
    return fsumF(x.map((v, i) => (v - xb) * (y[i] - yb))) / (n - 1);
  },
  linear_regression: a => {
    const x = numList(a[0], 'linear_regression').map(toF), y = numList(a[1], 'linear_regression').map(toF);
    if (x.length !== y.length) statErr('linear regression requires that both inputs have same number of data points');
    if (x.length < 2) statErr('linear regression requires at least two data points');
    const n = x.length, xb = fsumF(x) / n, yb = fsumF(y) / n;
    const sxy = fsumF(x.map((v, i) => (v - xb) * (y[i] - yb))), sxx = fsumF(x.map(v => (v - xb) ** 2));
    if (sxx === 0) statErr('x is constant');
    const slope = sxy / sxx, o = new PyObj(LR_CLASS);
    o.d.set('slope', slope); o.d.set('intercept', yb - slope * xb);
    return o;
  },
});
const LR_CLASS = mkClass('LinearRegression', [C_object]);
LR_CLASS.d.set('__iter__', new PyBuiltin('__iter__', a => getIterObj([a[0].d.get('slope'), a[0].d.get('intercept')])));
LR_CLASS.d.set('__repr__', new PyBuiltin('__repr__', a => 'LinearRegression(slope=' + fmtFloat(a[0].d.get('slope')) + ', intercept=' + fmtFloat(a[0].d.get('intercept')) + ')'));
function getIterObj(arr) { let i = 0; return new PyIter(() => i < arr.length ? arr[i++] : DONE, 'iterator'); }
MODULES.statistics.d.set('StatisticsError', EXC.StatisticsError);

function importModule(name) {
  const m = MODULES[name];
  if (!m) raise('ModuleNotFoundError', "No module named '" + name + "'");
  return m;
}

/* json */
function jsonDump(v, indent, sortKeys, ensureAscii, level) {
  const nl = indent === null ? '' : '\n' + ' '.repeat(indent * (level + 1));
  const nl0 = indent === null ? '' : '\n' + ' '.repeat(indent * level);
  const sep = indent === null ? ', ' : ',';
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : fmtFloat(v);
  if (typeof v === 'string') {
    let s = JSON.stringify(v);
    if (ensureAscii) s = s.replace(/[\u0080-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
    return s;
  }
  if (Array.isArray(v) || v instanceof PyTuple) {
    const a = Array.isArray(v) ? v : v.a;
    if (!a.length) return '[]';
    return '[' + nl + a.map(x => jsonDump(x, indent, sortKeys, ensureAscii, level + 1)).join(sep + nl) + nl0 + ']';
  }
  if (v instanceof PyDict) {
    let es = Array.from(v.m.values());
    if (!es.length) return '{}';
    es = es.map(e => { const k = e[0]; const ks = typeof k === 'string' ? k : k === null ? 'null' : typeof k === 'boolean' ? (k ? 'true' : 'false') : isNum(k) ? pyStr(k) : raise('TypeError', 'keys must be str, int, float, bool or None, not ' + typeName(k)); return [ks, e[1]]; });
    if (sortKeys) es.sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));
    return '{' + nl + es.map(e => jsonDump(e[0], null, false, ensureAscii, 0) + ': ' + jsonDump(e[1], indent, sortKeys, ensureAscii, level + 1)).join(sep + nl) + nl0 + '}';
  }
  raise('TypeError', 'Object of type ' + typeName(v) + ' is not JSON serializable');
}
function jsonConv(x) {
  if (x === null || typeof x === 'boolean' || typeof x === 'string') return x;
  if (typeof x === 'number') return x;
  if (Array.isArray(x)) return x.map(jsonConv);
  const d = new PyDict();
  for (const k of Object.keys(x)) dictSet(d, k, jsonConv(x[k]));
  return d;
}
mkMod('json', {
  dumps: (a, kw) => {
    kw = kw || {};
    const ind = kw.indent === undefined || kw.indent === null ? null : Number(toBig(kw.indent));
    return jsonDump(a[0], ind, kw.sort_keys !== undefined && truthy(kw.sort_keys), kw.ensure_ascii === undefined || truthy(kw.ensure_ascii), 0);
  },
  loads: a => {
    const text = needStr(a[0], 'the JSON object');
    let parsed;
    try { parsed = JSON.parse(text, function (k, v) { return v; }); }
    catch (e) { raise('ValueError', 'JSON non valido: ' + e.message); }
    // distingue interi e decimali rileggendo il testo
    const ints = /^-?\d+$/;
    const conv = (x, src) => x;
    const walk = x => {
      if (typeof x === 'number') return x;
      return x;
    };
    const rev = JSON.parse(text.replace(/("(?:[^"\\]|\\.)*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g, (m, s, n) => s ? s : (/[.eE]/.test(n) ? n : '"__I' + n + '"')));
    const fix = x => {
      if (typeof x === 'string') return /^__I-?\d+$/.test(x) ? BigInt(x.slice(3)) : x;
      if (Array.isArray(x)) return x.map(fix);
      if (x && typeof x === 'object') { const d = new PyDict(); for (const k of Object.keys(x)) dictSet(d, k, fix(x[k])); return d; }
      return x;
    };
    return fix(rev);
  },
});

/* ===================== INTERPRETE ===================== */
class Scope {
  constructor(parent, kind) { this.v = new Map(); this.parent = parent; this.kind = kind; this.glob = null; this.nonl = null; this.locals = null; }
}
const BRK = { sig: 'break' }, CNT = { sig: 'continue' };
class Ret { constructor(v) { this.v = v; } }

function ctxWrite(s) {
  ctx.outLen += s.length;
  if (ctx.outLen > ctx.maxOutput) throw new PyAbort('output', "Output troppo lungo: il programma è stato fermato dopo " + ctx.maxOutput + " caratteri.");
  ctx.write(s);
}
function tick() {
  if (++ctx.steps > ctx.maxSteps) throw new PyAbort('steps', 'Il programma è stato fermato: troppe operazioni eseguite (ciclo infinito?).');
  if ((ctx.steps & 4095) === 0 && Date.now() - ctx.t0 > ctx.maxMs) throw new PyAbort('time', 'Il programma è stato fermato: ha impiegato più di ' + Math.round(ctx.maxMs / 1000) + ' secondi (ciclo infinito?).');
}

/* nomi assegnati in un corpo (per decidere le variabili locali) */
function collectTargets(t, out) {
  if (!t) return;
  switch (t.k) {
    case 'Name': out.add(t.id); break;
    case 'Tuple': case 'List': t.elts.forEach(e => collectTargets(e, out)); break;
    case 'Star': collectTargets(t.e, out); break;
  }
}
function collectLocals(body, out, glob, nonl) {
  for (const s of body) {
    switch (s.k) {
      case 'Assign': s.targets.forEach(t => collectTargets(t, out)); break;
      case 'AugAssign': collectTargets(s.target, out); break;
      case 'For': collectTargets(s.target, out); collectLocals(s.body, out, glob, nonl); collectLocals(s.orelse, out, glob, nonl); break;
      case 'While': collectLocals(s.body, out, glob, nonl); collectLocals(s.orelse, out, glob, nonl); break;
      case 'If': collectLocals(s.body, out, glob, nonl); collectLocals(s.orelse, out, glob, nonl); break;
      case 'Try':
        collectLocals(s.body, out, glob, nonl); collectLocals(s.orelse, out, glob, nonl); collectLocals(s.finalbody, out, glob, nonl);
        s.handlers.forEach(h => { if (h.name) out.add(h.name); collectLocals(h.body, out, glob, nonl); }); break;
      case 'FuncDef': case 'ClassDef': out.add(s.name); break;
      case 'Import': s.names.forEach(n => out.add(n.asname || n.name.split('.')[0])); break;
      case 'ImportFrom': if (s.names !== '*') s.names.forEach(n => out.add(n.asname || n.name)); break;
      case 'Global': s.names.forEach(n => glob.add(n)); break;
      case 'Nonlocal': s.names.forEach(n => nonl.add(n)); break;
      case 'Del': s.targets.forEach(t => collectTargets(t, out)); break;
    }
  }
}
function analyze(node) {
  if (node._an) return node._an;
  const locals = new Set(), glob = new Set(), nonl = new Set();
  node.params.forEach(p => locals.add(p.name));
  if (Array.isArray(node.body)) collectLocals(node.body, locals, glob, nonl);
  glob.forEach(n => locals.delete(n));
  return (node._an = { locals, glob: glob.size ? glob : null, nonl: nonl.size ? nonl : null });
}

function lookup(scope, id) {
  let s = scope;
  if (s.glob !== null && s.glob.has(id)) s = ctx.globals;
  const own = s.v.get(id);
  if (own !== undefined) return own;
  if (s.kind === 'func' && s.locals.has(id) && !(s.nonl !== null && s.nonl.has(id))) raise('UnboundLocalError', "cannot access local variable '" + id + "' where it is not associated with a value");
  for (let p = s.parent; p !== null; p = p.parent) {
    if (p.kind === 'class') continue;
    const x = p.v.get(id);
    if (x !== undefined) return x;
  }
  const b = BUILTINS.get(id);
  if (b !== undefined) return b;
  raise('NameError', "name '" + id + "' is not defined");
}
function assignName(scope, id, val) {
  if (scope.glob !== null && scope.glob.has(id)) { ctx.globals.v.set(id, val); return; }
  if (scope.nonl !== null && scope.nonl.has(id)) {
    for (let p = scope.parent; p !== null; p = p.parent) if (p.kind === 'func' && (p.v.has(id) || p.locals.has(id))) { p.v.set(id, val); return; }
    throw new PySyntaxError('SyntaxError', "no binding for nonlocal '" + id + "' found", ctx.line);
  }
  scope.v.set(id, val);
}
EXC.UnboundLocalError = mkClass('UnboundLocalError', [EXC.NameError]);
EXC.MemoryError = mkClass('MemoryError', [EXC.Exception]);
BUILTINS.set('UnboundLocalError', EXC.UnboundLocalError);
BUILTINS.set('MemoryError', EXC.MemoryError);

/* ---- funzioni ---- */
function makeFunction(node, scope, isLambda) {
  const an = analyze(node);
  const defaults = node.params.map(p => p.default ? evalExpr(p.default, scope) : undefined);
  const f = new PyFunction(isLambda ? '<lambda>' : node.name, node.params, defaults, node.body, scope, isLambda);
  f.an = an;
  f.qname = f.name;
  return f;
}
function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }
function listNames(ns) { const q = ns.map(n => "'" + n + "'"); if (q.length === 1) return q[0]; if (q.length === 2) return q.join(' and '); return q.slice(0, -1).join(', ') + ', and ' + q[q.length - 1]; }
function callFunction(fn, args, kw) {
  const sc = new Scope(fn.closure, 'func');
  sc.locals = fn.an.locals; sc.glob = fn.an.glob; sc.nonl = fn.an.nonl;
  const ps = fn.params;
  let ai = 0, varargP = null, kwargP = null;
  const pos = [];
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.kind === 'pos') pos.push(i); else if (p.kind === 'vararg') varargP = p; else if (p.kind === 'kwarg') kwargP = p;
  }
  const v = sc.v;
  const np = pos.length;
  for (let j = 0; j < np && ai < args.length; j++, ai++) v.set(ps[pos[j]].name, args[ai]);
  if (ai < args.length) {
    if (varargP) v.set(varargP.name, new PyTuple(args.slice(ai)));
    else raise('TypeError', fn.qname + '() takes ' + (np === 1 ? '1 positional argument' : np + ' positional arguments') + ' but ' + args.length + (args.length === 1 ? ' was' : ' were') + ' given');
  } else if (varargP) v.set(varargP.name, new PyTuple([]));
  let extra = null;
  if (kwargP) { extra = new PyDict(); }
  if (kw !== null) {
    for (const k of Object.keys(kw)) {
      const idx = ps.findIndex(p => p.name === k && (p.kind === 'pos' || p.kind === 'kwonly'));
      if (idx >= 0) {
        if (v.has(k)) raise('TypeError', fn.qname + "() got multiple values for argument '" + k + "'");
        v.set(k, kw[k]);
      } else if (extra) dictSet(extra, k, kw[k]);
      else raise('TypeError', fn.qname + "() got an unexpected keyword argument '" + k + "'");
    }
  }
  if (kwargP) v.set(kwargP.name, extra);
  let missing = null, missingKw = null;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if ((p.kind === 'pos' || p.kind === 'kwonly') && !v.has(p.name)) {
      if (fn.defaults[i] !== undefined) v.set(p.name, fn.defaults[i]);
      else if (p.kind === 'pos') (missing || (missing = [])).push(p.name);
      else (missingKw || (missingKw = [])).push(p.name);
    }
  }
  if (missing) raise('TypeError', fn.qname + '() missing ' + plural(missing.length, 'required positional argument') + ': ' + listNames(missing));
  if (missingKw) raise('TypeError', fn.qname + '() missing ' + plural(missingKw.length, 'required keyword-only argument') + ': ' + listNames(missingKw));
  const prev = ctx.frame;
  const frame = { name: fn.name, line: ctx.line, fn, a0: args.length ? args[0] : (pos.length ? v.get(ps[pos[0]].name) : undefined) };
  if (++ctx.depth > ctx.maxDepth) { ctx.depth--; raise('RecursionError', 'maximum recursion depth exceeded'); }
  ctx.frame = frame;
  tick();
  try {
    if (fn.isLambda) return evalExpr(fn.body, sc);
    const r = execBlock(fn.body, sc);
    return r instanceof Ret ? r.v : null;
  } catch (e) {
    if (e instanceof RangeError) e = new PyThrow(makeExc('RecursionError', 'maximum recursion depth exceeded'));
    if (e instanceof PyThrow) { (e.trace || (e.trace = [])).push({ name: fn.name, line: frame.line }); }
    throw e;
  } finally {
    ctx.depth--; ctx.frame = prev; ctx.line = prev.line;
  }
}

/* ---- assegnazione ---- */
function assignTo(t, val, scope) {
  switch (t.k) {
    case 'Name': assignName(scope, t.id, val); return;
    case 'Attr': setAttr(evalExpr(t.obj, scope), t.name, val); return;
    case 'Sub': setItem(evalExpr(t.obj, scope), evalSub(t.idx, scope), val); return;
    case 'Tuple': case 'List': {
      const items = toArray(val);
      const si = t.elts.findIndex(e => e.k === 'Star');
      if (si < 0) {
        if (items.length !== t.elts.length) raise('ValueError', items.length > t.elts.length ? 'too many values to unpack (expected ' + t.elts.length + ')' : 'not enough values to unpack (expected ' + t.elts.length + ', got ' + items.length + ')');
        for (let i = 0; i < items.length; i++) assignTo(t.elts[i], items[i], scope);
      } else {
        const after = t.elts.length - si - 1;
        if (items.length < t.elts.length - 1) raise('ValueError', 'not enough values to unpack (expected at least ' + (t.elts.length - 1) + ', got ' + items.length + ')');
        for (let i = 0; i < si; i++) assignTo(t.elts[i], items[i], scope);
        assignTo(t.elts[si].e, items.slice(si, items.length - after), scope);
        for (let i = 0; i < after; i++) assignTo(t.elts[si + 1 + i], items[items.length - after + i], scope);
      }
      return;
    }
  }
  raise('SyntaxError', 'cannot assign');
}
function evalSub(idx, scope) {
  if (idx.k === 'Slice') return new PySlice(idx.lo ? evalExpr(idx.lo, scope) : null, idx.hi ? evalExpr(idx.hi, scope) : null, idx.step ? evalExpr(idx.step, scope) : null);
  return evalExpr(idx, scope);
}

/* ---- espressioni ---- */
function evalArgs(argNodes, scope) {
  const args = []; let kw = null;
  for (const a of argNodes) {
    if (a.kw !== undefined) { if (kw === null) kw = Object.create(null); if (a.kw in kw) throw new PySyntaxError('SyntaxError', 'keyword argument repeated: ' + a.kw, ctx.line); kw[a.kw] = evalExpr(a.e, scope); }
    else if (a.star) { for (const x of toArray(evalExpr(a.e, scope))) args.push(x); }
    else if (a.dstar) {
      const d = evalExpr(a.e, scope);
      if (!(d instanceof PyDict)) raise('TypeError', 'argument after ** must be a mapping, not ' + typeName(d));
      if (kw === null) kw = Object.create(null);
      for (const e of d.m.values()) { if (typeof e[0] !== 'string') raise('TypeError', 'keywords must be strings'); kw[e[0]] = e[1]; }
    } else args.push(evalExpr(a.e, scope));
  }
  return [args, kw];
}
function* compGen(n, scope, gi, firstIter) {
  const g = n.gens[gi];
  const nx = getIter(gi === 0 ? firstIter : evalExpr(g.iter, scope));
  for (let x = nx(); x !== DONE; x = nx()) {
    assignTo(g.target, x, scope);
    let ok = true;
    for (const c of g.ifs) { if (!truthy(evalExpr(c, scope))) { ok = false; break; } }
    if (!ok) continue;
    tick();
    if (gi + 1 < n.gens.length) yield* compGen(n, scope, gi + 1, null);
    else if (n.k === 'DictComp') yield [evalExpr(n.key, scope), evalExpr(n.value, scope)];
    else yield evalExpr(n.elt, scope);
  }
}
function compScope(n, scope) {
  const sc = new Scope(scope, 'func');
  const loc = new Set();
  n.gens.forEach(g => collectTargets(g.target, loc));
  sc.locals = loc;
  return sc;
}
function startComp(n, scope) {
  const first = evalExpr(n.gens[0].iter, scope);
  return compGen(n, compScope(n, scope), 0, first);
}
function fstringValue(parts, scope) {
  let out = '';
  for (const p of parts) {
    if (p.lit !== undefined) { out += p.lit; continue; }
    let v = evalExpr(p.expr, scope);
    if (p.conv === 'r' || p.conv === 'a') v = pyRepr(v); else if (p.conv === 's') v = pyStr(v);
    const spec = p.spec ? fstringValue(p.spec.parts, scope) : '';
    out += formatValue(v, spec);
  }
  return out;
}
const CMP_DUNDER = { '<': '__lt__', '>': '__gt__', '<=': '__le__', '>=': '__ge__' };
function compare(op, a, b) {
  switch (op) {
    case '==': return eq(a, b);
    case '!=': { if (a instanceof PyObj) { const m = findAttr(a.cls, '__ne__'); if (m !== undefined) return truthy(callValue(m, [a, b])); } return !eq(a, b); }
    case '<': case '>': case '<=': case '>=': return ordered(op, a, b);
    case 'is': return isIdent(a, b);
    case 'is not': return !isIdent(a, b);
    case 'in': return contains(b, a);
    case 'not in': return !contains(b, a);
  }
}
function evalExpr(n, scope) {
  switch (n.k) {
    case 'Const': return n.v;
    case 'Name': return lookup(scope, n.id);
    case 'BinOp': {
      if (n.op === '@') raise('TypeError', "l'operatore @ non è supportato in questo editor");
      return binop(n.op, evalExpr(n.l, scope), evalExpr(n.r, scope));
    }
    case 'UnaryOp':
      if (n.op === 'not') return !truthy(evalExpr(n.e, scope));
      return unop(n.op, evalExpr(n.e, scope));
    case 'BoolOp': {
      let v;
      if (n.op === 'and') { for (const e of n.vals) { v = evalExpr(e, scope); if (!truthy(v)) return v; } return v; }
      for (const e of n.vals) { v = evalExpr(e, scope); if (truthy(v)) return v; } return v;
    }
    case 'Compare': {
      let l = evalExpr(n.first, scope);
      for (const c of n.ops) {
        const r = evalExpr(c.e, scope);
        if (!compare(c.op, l, r)) return false;
        l = r;
      }
      return true;
    }
    case 'IfExp': return truthy(evalExpr(n.test, scope)) ? evalExpr(n.body, scope) : evalExpr(n.orelse, scope);
    case 'Call': {
      const fnode = n.func;
      if (fnode.k === 'Name' && fnode.id === 'super' && n.args.length === 0 && !(scope.v.has('super'))) return makeSuper();
      const f = evalExpr(fnode, scope);
      const [args, kw] = evalArgs(n.args, scope);
      ctx.line = n.line;
      if (f instanceof PyFunction) return callFunction(f, args, kw);
      return callValue(f, args, kw);
    }
    case 'Attr': return getAttr(evalExpr(n.obj, scope), n.name);
    case 'Sub': return getItem(evalExpr(n.obj, scope), evalSub(n.idx, scope));
    case 'List': return evalSeq(n.elts, scope);
    case 'Tuple': return new PyTuple(evalSeq(n.elts, scope));
    case 'Set': { const s = new PySet(); for (const x of evalSeq(n.elts, scope)) s.m.set(hk(x), [x, null]); return s; }
    case 'Dict': {
      const d = new PyDict();
      for (let i = 0; i < n.keys.length; i++) {
        if (n.keys[i] === null) { const o = evalExpr(n.values[i], scope); if (!(o instanceof PyDict)) raise('TypeError', "'" + typeName(o) + "' object is not a mapping"); for (const e of Array.from(o.m.values())) dictSet(d, e[0], e[1]); }
        else dictSet(d, evalExpr(n.keys[i], scope), evalExpr(n.values[i], scope));
      }
      return d;
    }
    case 'FStr': return fstringValue(n.parts, scope);
    case 'Lambda': return makeFunction(n, scope, true);
    case 'ListComp': return Array.from(startComp(n, scope));
    case 'SetComp': { const s = new PySet(); for (const x of startComp(n, scope)) s.m.set(hk(x), [x, null]); return s; }
    case 'DictComp': { const d = new PyDict(); for (const kv of startComp(n, scope)) dictSet(d, kv[0], kv[1]); return d; }
    case 'GenExp': { const g = startComp(n, scope); return new PyIter(() => { const r = g.next(); return r.done ? DONE : r.value; }, 'generator'); }
    case 'Star': raise('SyntaxError', "can't use starred expression here");
    case 'Slice': return evalSub(n, scope);
  }
  throw new Error('nodo non gestito: ' + n.k);
}
function evalSeq(elts, scope) {
  const out = [];
  for (const e of elts) {
    if (e.k === 'Star') { for (const x of toArray(evalExpr(e.e, scope))) out.push(x); }
    else out.push(evalExpr(e, scope));
  }
  return out;
}
function makeSuper() {
  const fr = ctx.frame;
  if (!fr.fn || !fr.fn.home) raise('RuntimeError', 'super(): no arguments');
  if (fr.a0 === undefined) raise('RuntimeError', 'super(): no arguments');
  return new PySuper(fr.fn.home, fr.a0);
}
BUILTINS.set('super', new PyBuiltin('super', a => {
  if (a.length === 2) return new PySuper(a[0], a[1]);
  return makeSuper();
}, 'super'));

/* ---- istruzioni ---- */
function execBlock(body, scope) {
  for (let i = 0; i < body.length; i++) {
    const r = execStmt(body[i], scope);
    if (r !== undefined) return r;
  }
  return undefined;
}
function augAssign(n, scope) {
  const t = n.target, op = n.op;
  const apply = cur => {
    const val = evalExpr(n.value, scope);
    if (Array.isArray(cur) && op === '+') { for (const x of toArray(val)) cur.push(x); return cur; }
    if (Array.isArray(cur) && op === '*' && isInt(val)) { const r = repeatSeq(cur, val); cur.length = 0; for (const x of r) cur.push(x); return cur; }
    if (cur instanceof PySet && (op === '|' || op === '&' || op === '-' || op === '^') && val instanceof PySet) { const r = setOp(op, cur, val); cur.m = r.m; return cur; }
    if (cur instanceof PyObj) {
      const m = findAttr(cur.cls, '__i' + ({ '+': 'add', '-': 'sub', '*': 'mul', '/': 'truediv', '//': 'floordiv', '%': 'mod', '**': 'pow' }[op] || 'x') + '__');
      if (m !== undefined) return callValue(m, [cur, val]);
    }
    return binop(op, cur, val);
  };
  if (t.k === 'Name') { assignName(scope, t.id, apply(lookup(scope, t.id))); return; }
  if (t.k === 'Attr') { const o = evalExpr(t.obj, scope); setAttr(o, t.name, apply(getAttr(o, t.name))); return; }
  const o = evalExpr(t.obj, scope), i = evalSub(t.idx, scope);
  setItem(o, i, apply(getItem(o, i)));
}
function makeClass(n, scope) {
  const bases = n.bases.length ? n.bases.map(b => evalExpr(b, scope)) : [C_object];
  bases.forEach(b => { if (!(b instanceof PyClass)) raise('TypeError', "non è possibile ereditare da '" + typeName(b) + "' in questo editor (solo da classi e dalle eccezioni)"); });
  const cs = new Scope(scope, 'class');
  const r = execBlock(n.body, cs);
  const cls = mkClass(n.name, bases, cs.v);
  for (const [k, v] of cs.v) {
    if (v instanceof PyFunction) { v.home = cls; v.qname = n.name + '.' + v.name; }
    else if (v instanceof PyStatic || v instanceof PyClassMethod) { if (v.f instanceof PyFunction) { v.f.home = cls; v.f.qname = n.name + '.' + v.f.name; } }
    else if (v instanceof PyProperty) { [v.fget, v.fset].forEach(f => { if (f instanceof PyFunction) { f.home = cls; f.qname = n.name + '.' + f.name; } }); }
  }
  return cls;
}
function applyDecorators(decs, scope, obj) {
  for (let i = decs.length - 1; i >= 0; i--) {
    const d = evalExpr(decs[i], scope);
    if (d instanceof PyBuiltin && d.name === 'setter-marker') continue;
    obj = callValue(d, [obj]);
  }
  return obj;
}
function decoratorWithProperty(n, scope, fn) {
  // supporto @x.setter
  for (let i = n.decorators.length - 1; i >= 0; i--) {
    const d = n.decorators[i];
    if (d.k === 'Attr' && (d.name === 'setter' || d.name === 'getter' || d.name === 'deleter')) {
      const prop = evalExpr(d.obj, scope);
      if (prop instanceof PyProperty) {
        if (d.name === 'setter') return new PyProperty(prop.fget, fn);
        if (d.name === 'getter') return new PyProperty(fn, prop.fset);
        return prop;
      }
    }
  }
  return null;
}
function execStmt(n, scope) {
  ctx.line = n.line;
  ctx.frame.line = n.line;
  tick();
  switch (n.k) {
    case 'Expr': evalExpr(n.e, scope); return undefined;
    case 'Assign': {
      const v = evalExpr(n.value, scope);
      for (const t of n.targets) assignTo(t, v, scope);
      return undefined;
    }
    case 'AugAssign': augAssign(n, scope); return undefined;
    case 'If': {
      if (truthy(evalExpr(n.test, scope))) return execBlock(n.body, scope);
      return n.orelse.length ? execBlock(n.orelse, scope) : undefined;
    }
    case 'While': {
      while (truthy(evalExpr(n.test, scope))) {
        const r = execBlock(n.body, scope);
        if (r !== undefined) { if (r === BRK) return undefined; if (r !== CNT) return r; }
        tick();
        ctx.frame.line = n.line;
      }
      return n.orelse.length ? execBlock(n.orelse, scope) : undefined;
    }
    case 'For': {
      const nx = getIter(evalExpr(n.iter, scope));
      const simple = n.target.k === 'Name' ? n.target.id : null;
      for (let x = nx(); x !== DONE; x = nx()) {
        if (simple !== null) assignName(scope, simple, x); else assignTo(n.target, x, scope);
        const r = execBlock(n.body, scope);
        if (r !== undefined) { if (r === BRK) return undefined; if (r !== CNT) return r; }
        tick();
      }
      return n.orelse.length ? execBlock(n.orelse, scope) : undefined;
    }
    case 'Pass': return undefined;
    case 'Break': return BRK;
    case 'Continue': return CNT;
    case 'Return': return new Ret(n.e ? evalExpr(n.e, scope) : null);
    case 'FuncDef': {
      let f = makeFunction(n, scope, false);
      const prop = n.decorators.length ? decoratorWithProperty(n, scope, f) : null;
      if (prop) f = prop;
      else if (n.decorators.length) f = applyDecorators(n.decorators, scope, f);
      assignName(scope, n.name, f);
      return undefined;
    }
    case 'ClassDef': {
      let c = makeClass(n, scope);
      if (n.decorators.length) c = applyDecorators(n.decorators, scope, c);
      assignName(scope, n.name, c);
      return undefined;
    }
    case 'Try': return execTry(n, scope);
    case 'Raise': doRaise(n, scope); return undefined;
    case 'Assert': {
      if (!truthy(evalExpr(n.test, scope))) {
        if (n.msg) { const m = evalExpr(n.msg, scope); throw new PyThrow(makeExc('AssertionError', m)); }
        raise('AssertionError');
      }
      return undefined;
    }
    case 'Global': case 'Nonlocal': return undefined;
    case 'Import': {
      for (const nm of n.names) {
        const m = importModule(nm.name);
        assignName(scope, nm.asname || nm.name.split('.')[0], m);
      }
      return undefined;
    }
    case 'ImportFrom': {
      const m = importModule(n.mod);
      if (n.names === '*') { for (const [k, v] of m.d) if (k[0] !== '_') assignName(scope, k, v); return undefined; }
      for (const nm of n.names) {
        const v = m.d.get(nm.name);
        if (v === undefined) raise('ImportError', "cannot import name '" + nm.name + "' from '" + n.mod + "'");
        assignName(scope, nm.asname || nm.name, v);
      }
      return undefined;
    }
    case 'Del': {
      for (const t of n.targets) {
        if (t.k === 'Name') { if (!scope.v.delete(t.id)) raise('NameError', "name '" + t.id + "' is not defined"); }
        else if (t.k === 'Sub') delItem(evalExpr(t.obj, scope), evalSub(t.idx, scope));
        else if (t.k === 'Attr') { const o = evalExpr(t.obj, scope); if (o instanceof PyObj) { if (!o.d.delete(t.name)) noAttr(o, t.name); } else noAttr(o, t.name); }
        else if (t.k === 'Tuple') t.elts.forEach(e => execStmt({ k: 'Del', targets: [e], line: n.line }, scope));
      }
      return undefined;
    }
  }
  throw new Error('istruzione non gestita: ' + n.k);
}
function doRaise(n, scope) {
  if (!n.e) {
    const cur = ctx.excStack[ctx.excStack.length - 1];
    if (!cur) raise('RuntimeError', 'No active exception to reraise');
    throw new PyThrow(cur);
  }
  let v = evalExpr(n.e, scope);
  if (v instanceof PyClass && isSubclass(v, EXC.BaseException)) v = instantiate(v, [], null);
  if (!isExc(v)) raise('TypeError', 'exceptions must derive from BaseException');
  throw new PyThrow(v);
}
function convertErr(e) {
  if (e instanceof RangeError && /call stack/i.test(e.message)) return new PyThrow(makeExc('RecursionError', 'maximum recursion depth exceeded'));
  return e;
}
function execTry(n, scope) {
  let sig, pending = null;
  try { sig = runTry(n, scope); } catch (e) { pending = convertErr(e); }
  if (pending !== null && pending instanceof PyAbort) throw pending;
  if (n.finalbody.length) {
    const savedLine = ctx.line;
    const fs = execBlock(n.finalbody, scope);
    ctx.line = savedLine;
    if (fs !== undefined) return fs;
  }
  if (pending !== null) throw pending;
  return sig;
}
function runTry(n, scope) {
  let exc = null, sig;
  try { sig = execBlock(n.body, scope); } catch (e) { exc = convertErr(e); }
  if (exc === null) {
    if (sig !== undefined) return sig;
    return n.orelse.length ? execBlock(n.orelse, scope) : undefined;
  }
  if (!(exc instanceof PyThrow)) throw exc;
  const obj = exc.obj;
  for (const h of n.handlers) {
    let match = true;
    if (h.type) {
      const t = evalExpr(h.type, scope);
      const test = c => { if (c instanceof PyClass) return isSubclass(obj.cls, c); raise('TypeError', 'catching classes that do not inherit from BaseException is not allowed'); };
      match = t instanceof PyTuple ? t.a.some(test) : test(t);
    }
    if (!match) continue;
    if (h.name) assignName(scope, h.name, obj);
    ctx.excStack.push(obj);
    try { return execBlock(h.body, scope); }
    finally { ctx.excStack.pop(); if (h.name) scope.v.delete(h.name); }
  }
  throw exc;
}

/* ===================== ESECUZIONE ===================== */
function formatTraceback(e, srcLines) {
  const lines = ['Traceback (most recent call last):'];
  const tr = (e.trace || []).slice().reverse();
  const modLine = e.modLine || 0;
  const fmt = (name, line) => {
    let s = '  File "main.py", line ' + line + ', in ' + name;
    const code = srcLines[line - 1];
    if (code !== undefined && code.trim()) s += '\n    ' + code.trim();
    return s;
  };
  lines.push(fmt('<module>', modLine));
  let i = 0;
  while (i < tr.length) {
    let j = i;
    while (j < tr.length && tr[j].name === tr[i].name && tr[j].line === tr[i].line) j++;
    const cnt = j - i;
    for (let k = 0; k < Math.min(cnt, 3); k++) lines.push(fmt(tr[i].name, tr[i].line));
    if (cnt > 3) lines.push('  [Previous line repeated ' + (cnt - 3) + ' more time' + (cnt - 3 === 1 ? '' : 's') + ']');
    i = j;
  }
  const o = e.obj;
  const msg = excStr(o);
  lines.push(o.cls.name + (msg !== '' ? ': ' + msg : ''));
  return lines.join('\n');
}
function run(source, opts) {
  opts = opts || {};
  const gscope = new Scope(null, 'module');
  ctx = {
    write: opts.write || (() => {}), inputs: (opts.inputs || []).slice(), maxSteps: opts.maxSteps || 40000000,
    maxOutput: opts.maxOutput || 200000, echo: opts.echoInput !== false, maxMs: opts.maxMs || 20000, steps: 0, outLen: 0, t0: Date.now(), line: 0,
    depth: 0, maxDepth: opts.maxDepth || 350, excStack: [], globals: gscope, frame: { name: '<module>', line: 0, fn: null }, slept: 0,
  };
  const srcLines = source.replace(/\r\n?/g, '\n').split('\n');
  let prog;
  try { prog = parseProgram(source); }
  catch (e) {
    if (e instanceof PySyntaxError) {
      const code = srcLines[e.line - 1];
      return { ok: false, kind: 'syntax', line: e.line, text: '  File "main.py", line ' + e.line + (code !== undefined && code.trim() ? '\n    ' + code.trim() : '') + '\n' + e.pyType + ': ' + e.msg };
    }
    throw e;
  }
  gscope.v.set('__name__', '__main__');
  try {
    execBlock(prog, gscope);
    return { ok: true, steps: ctx.steps };
  } catch (e0) {
    const e = convertErr(e0);
    if (e instanceof PyAbort) return { ok: false, kind: e.kind, line: ctx.line, text: e.message };
    if (e instanceof PySyntaxError) return { ok: false, kind: 'syntax', line: e.line, text: e.pyType + ': ' + e.msg };
    if (e instanceof PyThrow) {
      e.modLine = ctx.frame && ctx.frame.name === '<module>' ? ctx.frame.line : (ctx.frame ? ctx.frame.line : 0);
      return { ok: false, kind: 'exception', line: ctx.line, excType: e.obj.cls.name, excMsg: excStr(e.obj), text: formatTraceback(e, srcLines) };
    }
    return { ok: false, kind: 'internal', line: ctx.line, text: 'Errore interno dell\'interprete: ' + (e && e.message ? e.message : String(e)) };
  }
}

/* ===================== API ===================== */
const api = { run, PySyntaxError };
root.PyInterp = api;
if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
