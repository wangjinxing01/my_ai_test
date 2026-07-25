// ============================================================
// 读取 promptfoo_results.json,统计失败用例数
// 用于 Jenkins post-action 门禁判断
// ============================================================
// 始终退出码 0,失败数通过 stdout 输出(避免 bat 误判为失败)
//
// promptfoo JSON 结构(实测 v0.121.19):
//   {
//     "results": {
//       "version": 3,
//       "prompts": [
//         { "metrics": { "testFailCount": N, "testPassCount": N, ... } },
//         ...
//       ],
//       ...
//     }
//   }
// 每个 prompt 的 metrics.testFailCount 累加即为总失败用例数。
// ============================================================

const fs = require('fs');

let fails = 0;
try {
  const raw = fs.readFileSync('promptfoo_results.json', 'utf8');
  const data = JSON.parse(raw);
  const results = data.results || data;

  // v3 结构: results.prompts[].metrics.testFailCount
  if (results && Array.isArray(results.prompts)) {
    for (const p of results.prompts) {
      const m = p.metrics || {};
      fails += m.testFailCount || 0;
    }
  } else if (Array.isArray(results)) {
    // 兼容旧结构: 数组形式,每项有 success 字段
    fails = results.filter((x) => x.success === false).length;
  } else {
    console.error('check-fails: 未知 JSON 结构,顶层 keys: ' + Object.keys(data).join(','));
  }
} catch (e) {
  console.error('check-fails: 无法解析 promptfoo_results.json: ' + e.message);
}
console.log(fails);
