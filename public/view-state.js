const VALID_VIEWS = new Set(['ledger', 'report', 'settings']);
const VALID_PERIODS = new Set(['daily', 'weekly', 'monthly', 'custom']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseViewStateHash(hash) {
  const parts = String(hash || '').replace(/^#/, '').split('/').filter(Boolean);
  const [first, second, third] = parts;

  if (VALID_VIEWS.has(first)) {
    return {
      view: first,
      period: VALID_PERIODS.has(second) ? second : 'daily',
      currentDate: DATE_RE.test(third || '') ? third : '',
    };
  }

  return {
    view: 'ledger',
    period: VALID_PERIODS.has(first) ? first : 'daily',
    currentDate: DATE_RE.test(second || '') ? second : '',
  };
}

export function formatViewStateHash({ view = 'ledger', period = 'daily', currentDate = '' } = {}) {
  const safeView = VALID_VIEWS.has(view) ? view : 'ledger';
  const safePeriod = VALID_PERIODS.has(period) ? period : 'daily';
  const safeDate = DATE_RE.test(currentDate) ? currentDate : '';
  return [safeView, safePeriod, safeDate].filter(Boolean).join('/');
}
