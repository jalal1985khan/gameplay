const assert = require('assert');
const {test, loadPage, El, chipsOf} = require('./harness');

// A page with a header, a pagination row (plain numbers) and the results list.
function gamePage(values) {
  const list = new El('DIV', '', chipsOf(values));
  const pager = new El('NAV', '', chipsOf([1, 2, 3, 4, 5, 6]));
  const live = new El('DIV', '', [new El('SPAN', '1.84x')]);
  const body = new El('BODY', '', [new El('H1', 'Aviator'), pager, live, list]);
  return {body, list};
}
const snapshots = page => page.sent.filter(m => m.type === 'AVIATOR_SNAPSHOT');

test('content: finds the results list and sends it on injection', () => {
  const {body} = gamePage(['x4.19', '2.50x', '1.00x', '1,204.50x', '1.48×']);
  const page = loadPage(body);
  page.inject();
  assert.deepStrictEqual(snapshots(page), [{type: 'AVIATOR_SNAPSHOT', values: [4.19, 2.5, 1, 1204.5, 1.48], newCount: null}]);
});

test('content: accepts two-decimal labels without x, rejects page numbers', () => {
  const {body} = gamePage(['2.00', '1.37', '11.20', '1.00', '3.05']);
  const page = loadPage(body);
  page.inject();
  assert.deepStrictEqual(snapshots(page)[0].values, [2, 1.37, 11.2, 1, 3.05]);
  const pagerOnly = loadPage(new El('BODY', '', [new El('NAV', '', chipsOf([1, 2, 3, 4, 5, 6, 7]))]));
  pagerOnly.inject();
  assert.deepStrictEqual(snapshots(pagerOnly), []);
});

test('content: hidden lists are ignored', () => {
  const {body, list} = gamePage(['1.10x', '2.20x', '3.30x', '4.40x', '5.50x']);
  list.hidden = true;
  const page = loadPage(body);
  page.inject();
  assert.deepStrictEqual(snapshots(page), []);
});

test('content: a prepended round is reported with its new-element count', () => {
  const {body, list} = gamePage(['5.00x', '4.00x', '3.00x', '2.00x', '1.00x']);
  const page = loadPage(body);
  page.inject();
  list.children.unshift(new El('DIV', '6.00x'));
  list.children.pop();
  page.mutate();
  assert.deepStrictEqual(snapshots(page).at(-1), {type: 'AVIATOR_SNAPSHOT', values: [6, 5, 4, 3, 2], newCount: 1});
});

test('content: unchanged list sends nothing; a repeated value still counts', () => {
  const {body, list} = gamePage(['1.00x', '1.00x', '1.00x', '1.00x', '1.00x']);
  const page = loadPage(body);
  page.inject();
  page.mutate();
  assert.strictEqual(snapshots(page).length, 1);
  list.children.unshift(new El('DIV', '1.00x'));
  list.children.pop();
  page.mutate();
  assert.deepStrictEqual(snapshots(page).at(-1), {type: 'AVIATOR_SNAPSHOT', values: [1, 1, 1, 1, 1], newCount: 1});
});

test('content: a list rebuilt from scratch gives no element count', () => {
  const {body, list} = gamePage(['5.00x', '4.00x', '3.00x', '2.00x', '1.00x']);
  const page = loadPage(body);
  page.inject();
  list.children = chipsOf(['6.00x', '5.00x', '4.00x', '3.00x', '2.00x']);
  page.mutate();
  assert.deepStrictEqual(snapshots(page).at(-1), {type: 'AVIATOR_SNAPSHOT', values: [6, 5, 4, 3, 2], newCount: null});
});

test('content: a replaced list element is found again', () => {
  const {body, list} = gamePage(['5.00x', '4.00x', '3.00x', '2.00x', '1.00x']);
  const page = loadPage(body);
  page.inject();
  list.isConnected = false;
  body.children.splice(body.children.indexOf(list), 1, new El('DIV', '', chipsOf(['7.00x', '5.00x', '4.00x', '3.00x', '2.00x'])));
  page.mutate();
  assert.deepStrictEqual(snapshots(page).at(-1).values, [7, 5, 4, 3, 2]);
});

test('content: injecting again shuts the previous copy down', () => {
  const {body} = gamePage(['5.00x', '4.00x', '3.00x', '2.00x', '1.00x']);
  const page = loadPage(body);
  page.inject();
  page.inject();
  assert.strictEqual(page.observers.filter(o => o.active).length, 1);
  assert.strictEqual(page.chrome.runtime.onMessage.listeners.length, 1);
  assert.strictEqual(page.docListeners.length, 1);
});

test('content: stop message tears down observer and listeners', () => {
  const {body, list} = gamePage(['5.00x', '4.00x', '3.00x', '2.00x', '1.00x']);
  const page = loadPage(body);
  page.inject();
  page.chrome.runtime.onMessage.fire({type: 'AVIATOR_STOP'});
  assert.strictEqual(page.observers.filter(o => o.active).length, 0);
  assert.strictEqual(page.chrome.runtime.onMessage.listeners.length, 0);
  assert.strictEqual(page.ctx.window.__aviatorObserver, undefined);
  list.children.unshift(new El('DIV', '6.00x'));
  page.mutate();
  assert.strictEqual(snapshots(page).length, 1);
});

test('content: a child iframe loading is reported, other loads are not', () => {
  const {body} = gamePage(['5.00x', '4.00x', '3.00x', '2.00x', '1.00x']);
  const page = loadPage(body);
  page.inject();
  page.fireLoad('IMG');
  page.fireLoad('IFRAME');
  assert.deepStrictEqual(page.sent.filter(m => m.type === 'AVIATOR_FRAME_LOADED'), [{type: 'AVIATOR_FRAME_LOADED'}]);
});

test('content: an invalidated extension context shuts the copy down', () => {
  const {body, list} = gamePage(['5.00x', '4.00x', '3.00x', '2.00x', '1.00x']);
  const page = loadPage(body);
  page.inject();
  page.breakRuntime();
  list.children.unshift(new El('DIV', '6.00x'));
  page.mutate();
  assert.strictEqual(page.observers.filter(o => o.active).length, 0);
});
