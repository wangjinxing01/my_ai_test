// ============================================================
// 读取 promptfoo_results.json,统计失败用例数
// 用于 Jenkins post-action 门禁判断
// ============================================================
// 始终退出码 0,失败数通过 stdout 输出(避免 bat 误判为失败)
// ============================================================

const fs = require('fs');

let fails = 0;
try {
  const raw = fs.readFileSync('promptfoo_results.json', 'utf8');
  const data = JSON.parse(raw);
  // promptfoo 结果格式: { results: [ { success: true/false, ... }, ... ] }
  const results = data.results || data;
  if (Array.isArray(results)) {
    fails = results.filter((x) => x.success === false).length;
  }
} catch (e) {
  console.error('check-fails: 无法解析 promptfoo_results.json: ' + e.message);
}
console.log(fails);
