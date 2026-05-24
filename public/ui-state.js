import { ID } from './config.js';
import { destroyChart } from './utils.js';

export function showSkeleton() {
  /* In the new design, Alpine.js reactive state handles loading indicators.
     This function is kept for API compatibility. */
}

export function hideSkeleton() {
  /*同上*/
}

export function showError(msg) {
  const toast = document.getElementById(ID.TOAST);
  if (!toast) return;
  toast.textContent = msg;
  toast.style.display = 'block';
  toast.style.opacity = '1';
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => { toast.style.display = 'none'; }, 300);
  }, 3000);
}

export function hideError() {
  const toast = document.getElementById(ID.TOAST);
  if (toast) toast.style.display = 'none';
}

export function showEmpty() {
  const wp = document.getElementById(ID.WELCOME_PAGE);
  if (wp) wp.style.display = 'flex';
}

export function hideEmpty() {
  const wp = document.getElementById(ID.WELCOME_PAGE);
  if (wp) wp.style.display = 'none';
}

export function clearReportUI(destroyChartFn) {
  hideEmpty();
  const keys = [ID.SCENARIO_CHART, ID.MODEL_CHART, ID.PROJECT_CHART, ID.TOOL_CHART, ID.TREND_CHART, ID.CACHE_CHART, ID.MODEL_COST_CHART];
  keys.forEach(destroyChart);
}
