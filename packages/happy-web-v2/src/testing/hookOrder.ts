/**
 * Static rules-of-hooks check (B-678). The repo has no ESLint, and AGENTS.md
 * forbids adding dependencies for one tool, so this walks the TypeScript AST
 * that `typescript` (already a devDependency) gives us.
 *
 * B-678: MachineScreen called `useState` after `if (!machine) return …`. A
 * cold load or refresh of /machine/<id> renders once with no machine and once
 * with it, so the hook count changed and React threw #310. Navigating from
 * Settings never hit it because the machine was already in storage.
 *
 * In a component (PascalCase) or hook (`useX`), a hook call (`useX(…)` or
 * `X.useY(…)`, outside nested functions) is reported when it:
 *  - after-return: comes after a `return` in the same function;
 *  - conditional: sits in an if/else branch, ternary branch, the right side of
 *    `&&`/`||`/`??`, a loop, a switch case, a catch/finally block, or an
 *    optional call chain.
 * React 19 `use()` may be conditional and is ignored.
 */
import ts from 'typescript';

export type HookOrderFinding = {
  kind: 'after-return' | 'conditional';
  fn: string;
  hook: string;
  line: number;
};

const HOOK_NAME = /^use[A-Z0-9]/;
const FN_NAME = /^(?:[A-Z]|use[A-Z0-9])/;

type FnNode = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration;

function isFn(node: ts.Node): node is FnNode {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node);
}

/** Name of a component/hook function, seen through memo(forwardRef(...)) wrappers. */
function fnName(node: FnNode): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) return node.name.text;
  let cur: ts.Node = node;
  while (ts.isCallExpression(cur.parent) && cur.parent.arguments.includes(cur as ts.Expression)) cur = cur.parent;
  if (ts.isVariableDeclaration(cur.parent) && ts.isIdentifier(cur.parent.name)) return cur.parent.name.text;
  return null;
}

function hookName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return HOOK_NAME.test(callee.text) ? callee.text : null;
  if (ts.isPropertyAccessExpression(callee)) return HOOK_NAME.test(callee.name.text) ? callee.name.text : null;
  return null;
}

/** True when `child` (a direct child of `parent`) only runs on some paths through `parent`. */
function isConditionalEdge(parent: ts.Node, child: ts.Node): boolean {
  if (ts.isIfStatement(parent)) return child !== parent.expression;
  if (ts.isConditionalExpression(parent)) return child !== parent.condition;
  if (ts.isBinaryExpression(parent)) {
    const op = parent.operatorToken.kind;
    const shortCircuit = op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken
      || op === ts.SyntaxKind.QuestionQuestionToken || op === ts.SyntaxKind.AmpersandAmpersandEqualsToken
      || op === ts.SyntaxKind.BarBarEqualsToken || op === ts.SyntaxKind.QuestionQuestionEqualsToken;
    return shortCircuit && child === parent.right;
  }
  if (ts.isForStatement(parent) || ts.isForInStatement(parent) || ts.isForOfStatement(parent)
    || ts.isWhileStatement(parent) || ts.isDoStatement(parent)) return true;
  if (ts.isCaseClause(parent) || ts.isDefaultClause(parent)) return true;
  if (ts.isTryStatement(parent)) return child !== parent.tryBlock;
  if (ts.isCallExpression(parent) && parent.questionDotToken) return child !== parent.expression;
  return false;
}

export function findHookOrderViolations(source: string, fileName = 'file.tsx'): HookOrderFinding[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings: HookOrderFinding[] = [];

  function checkFn(fn: FnNode, name: string) {
    if (!fn.body) return;
    const returns: number[] = [];
    const hooks: { call: ts.CallExpression; name: string; conditional: boolean }[] = [];
    function visit(node: ts.Node, conditional: boolean) {
      if (isFn(node)) return; // nested functions are checked on their own
      if (ts.isReturnStatement(node)) returns.push(node.end);
      if (ts.isCallExpression(node)) {
        const hook = hookName(node);
        if (hook) hooks.push({ call: node, name: hook, conditional });
      }
      node.forEachChild((child) => visit(child, conditional || isConditionalEdge(node, child)));
    }
    fn.body.forEachChild((child) => visit(child, false));
    for (const h of hooks) {
      const line = sf.getLineAndCharacterOfPosition(h.call.getStart(sf)).line + 1;
      if (returns.some((end) => end <= h.call.getStart(sf))) findings.push({ kind: 'after-return', fn: name, hook: h.name, line });
      else if (h.conditional) findings.push({ kind: 'conditional', fn: name, hook: h.name, line });
    }
  }

  function walk(node: ts.Node) {
    if (isFn(node)) {
      const name = fnName(node);
      if (name && FN_NAME.test(name)) checkFn(node, name);
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return findings;
}
