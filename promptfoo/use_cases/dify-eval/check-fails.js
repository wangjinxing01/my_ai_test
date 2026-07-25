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

  // promptfoo eval 输出格式: { results: [ { success, ... }, ... ] }
  // 兼容多种可能的结构
  let results = null;
  if (Array.isArray(data)) {
    results = data;
  } else if (data.results && Array.isArray(data.results)) {
    results = data.results;
  } else if (data.tests && Array.isArray(data.tests)) {
    results = data.tests;
  }

  if (results) {
    fails = results.filter((x) => x.success === false).length;
  } else {
    // 未知结构,打印顶层 keys 帮助调试
    console.error('check-fails: 未知 JSON 结构,顶层 keys: ' + Object.keys(data).join(','));
  }
} catch (e) {
  console.error('check-fails: 无法解析 promptfoo_results.json: ' + e.message);
}
console.log(fails);
