/**
 * Dify 动物图片识别工作流 - 断言函数集
 *
 * 所有断言逻辑集中在此文件，promptfooconfig.yaml 通过 file:// 引用。
 * 这样 YAML 里只写"用哪个函数"，具体判断逻辑在这里维护，可读性好。
 *
 * 函数签名：(output, context) => { pass, score, reason }
 *   - output: promptfoo 传入的输出（可能是字符串或已解析对象）
 *   - context.vars: 测试用例的变量（如 expected_name、expected_number）
 */

/**
 * 从 promptfoo 的 output 中提取工作流的实际输出对象。
 *
 * 改造后的 provider 按 outputPath(默认 data.outputs.output)提取字段,
 * 所以 promptfoo 传入的 output 已经是 LLM 输出的字符串(可能是 ```json 包裹的 JSON)。
 * 不再需要从完整 Dify 响应里解析。
 *
 * @param {string|object} output - promptfoo 传入的输出
 * @returns {object} 解析后的对象(如 {name, number, description})
 * @throws {Error} 解析失败时抛出,由调用方捕获
 */
function parseOutput(output) {
  const s = (typeof output === 'string' ? output : JSON.stringify(output))
    .replace(/```json/g, '')
    .replace(/```/g, '')
    .trim();
  return JSON.parse(s);
}

/**
 * 断言1：格式校验
 * 输出必须是 JSON，含 name(string)、number(number)、description(string) 三个字段。
 * 严格按 JSON 规范：数字不加引号，字符串加引号。
 */
function assertFormat(output) {
  let obj;
  try {
    obj = parseOutput(output);
  } catch (e) {
    return { pass: false, score: 0, reason: e.message };
  }
  const ok =
    typeof obj.name === 'string' &&
    typeof obj.number === 'number' &&
    typeof obj.description === 'string';
  return {
    pass: ok,
    score: ok ? 1 : 0,
    reason: ok ? '字段类型正确' : '字段类型应为 string/number/string，实际: ' + JSON.stringify(obj),
  };
}

/**
 * 断言2：number 精确匹配
 */
function assertNumber(output, context) {
  const obj = parseOutput(output);
  const expected = context.vars.expected_number;
  const ok = obj.number === expected;
  return {
    pass: ok,
    score: ok ? 1 : 0,
    reason: 'number=' + obj.number + '，期望=' + expected,
  };
}

/**
 * 断言3：description 字数 80~120
 */
function assertDescriptionLength(output) {
  const obj = parseOutput(output);
  const len = (obj.description || '').length;
  const ok = len >= 80 && len <= 120;
  return {
    pass: ok,
    score: ok ? 1 : 0,
    reason: 'description 字数=' + len + '，应在 80~120 之间',
  };
}

/**
 * transform：提取 name 字段（供 llm-rubric 断言4使用）
 * 失败时返回提示字符串，避免 "did not return a value"
 */
function transformName(output) {
  try {
    return parseOutput(output).name;
  } catch (e) {
    return '【解析失败】' + e.message;
  }
}

/**
 * transform：提取 description 字段（供 llm-rubric 断言5使用）
 */
function transformDescription(output) {
  try {
    return parseOutput(output).description;
  } catch (e) {
    return '【解析失败】' + e.message;
  }
}

module.exports = {
  assertFormat,
  assertNumber,
  assertDescriptionLength,
  transformName,
  transformDescription,
  parseOutput, // 导出供调试
};
