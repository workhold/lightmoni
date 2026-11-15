// Node SSR tests: CSS is a browser-side side effect, not a module contract.
export async function load(url, context, nextLoad) {
 if (url.endsWith('.css')) return { format: 'module', source: 'export default {}', shortCircuit: true };
 return nextLoad(url, context);
}
