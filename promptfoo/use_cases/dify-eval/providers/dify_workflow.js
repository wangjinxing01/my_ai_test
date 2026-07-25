/**
 * Dify 工作流 Custom Provider for promptfoo (配置驱动版)
 *
 * 解决问题:不同 Dify 工作流的输入/输出结构不同,硬编码每次都要改 JS。
 * 方案:把输入/输出结构配置到 promptfooconfig.yaml,provider 按配置执行。
 *
 * 支持的输入类型:
 *   - file_array: 文件数组(Dify 的 Array[File],如多图输入)
 *   - file:       单个文件(Dify 的 File)
 *   - text:       纯文本字符串(不用上传,直接塞进 inputs)
 *
 * 配置示例(promptfooconfig.yaml):
 *   providers:
 *     - id: file://providers/dify_workflow.js
 *       config:
 *         baseUrl: http://dify.mycompany.com:5001/v1   # 或用环境变量 DIFY_BASE_URL
 *         apiKey: app-xxx                                # 或用环境变量 DIFY_API_KEY
 *         user: abc-123                                  # 或用环境变量 DIFY_USER
 *         inputs:
 *           - varName: input_picture
 *             type: file_array
 *             source: filename          # 从 tests.json 的 vars.filename 取
 *             mimeType: image/jpeg
 *           - varName: user_question
 *             type: text
 *             source: question          # 从 tests.json 的 vars.question 取
 *         outputPath: data.outputs.output   # 从 Dify 响应取哪个字段(支持 a.b.c 路径)
 *
 * 每个 test 用例的 vars 里需提供所有 source 指定的字段。
 *
 * promptfoo 会 new 本模块导出的类,并调用其 callApi 方法。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

class DifyWorkflowProvider {
  constructor(providerOptions = {}) {
    // promptfoo 传入的是 { config: {...}, id, label, ... },真正配置在 config 字段下
    const config = providerOptions.config || providerOptions;
    this.config = config;
    this.providerId = providerOptions.id || 'dify_workflow';

    this.baseUrl = (config.baseUrl || process.env.DIFY_BASE_URL || '').replace(/\/$/, '');
    this.apiKey = config.apiKey || process.env.DIFY_API_KEY;
    this.user = config.user || process.env.DIFY_USER || 'abc-123';

    // 输入配置:必须是非空数组
    this.inputConfigs = Array.isArray(config.inputs) ? config.inputs : [];
    // 输出路径:从 Dify 响应取哪个字段(默认 data.outputs.output)
    this.outputPath = config.outputPath || 'data.outputs.output';

    // 默认图片/文件目录:相对本 provider 脚本所在 providers/ 的 ../inputs
    this.filesDir = config.filesDir
      ? path.resolve(config.filesDir)
      : path.join(__dirname, '..', 'inputs');

    if (!this.baseUrl || !this.apiKey) {
      throw new Error('DifyWorkflowProvider: 缺少 baseUrl 或 apiKey,请在 provider config 或环境变量中配置');
    }
    if (this.inputConfigs.length === 0) {
      throw new Error('DifyWorkflowProvider: 缺少 inputs 配置,请配置至少一个输入项');
    }
  }

  // promptfoo 要求:返回 provider 标识
  id() {
    return this.providerId;
  }

  toString() {
    return `[Dify Workflow Provider ${this.providerId}]`;
  }

  // promptfoo 调用入口
  async callApi(prompt, context = {}, options = {}) {
    const vars = (context && context.vars) || {};

    // 1. 按配置构造 inputs
    const inputs = {};
    const uploadTasks = []; // 记录需要上传的文件,异步并行执行

    for (const cfg of this.inputConfigs) {
      const value = vars[cfg.source];
      if (value === undefined || value === null) {
        throw new Error(`用例 vars 缺少 "${cfg.source}" 字段(对应工作流输入 "${cfg.varName}")`);
      }

      if (cfg.type === 'text') {
        // 纯文本:直接塞字符串
        inputs[cfg.varName] = String(value);
      } else if (cfg.type === 'file' || cfg.type === 'file_array') {
        // 文件:可能是单个文件名,或文件名数组
        const filenames = Array.isArray(value) ? value : [value];
        const fileInfos = filenames.map((fn) => {
          const filePath = path.join(this.filesDir, fn);
          if (!fs.existsSync(filePath)) {
            throw new Error(`文件不存在: ${filePath}`);
          }
          return { filename: fn, filePath, mimeType: cfg.mimeType || 'image/jpeg' };
        });
        uploadTasks.push({ cfg, fileInfos });
      } else {
        throw new Error(`不支持的输入类型 "${cfg.type}",应为 file_array / file / text`);
      }
    }

    // 2. 并行上传所有文件
    const uploaded = {};
    for (const { cfg, fileInfos } of uploadTasks) {
      const fileIds = [];
      for (const info of fileInfos) {
        console.log(`[dify_provider] 上传 ${info.filename}`);
        const fileId = await this.uploadFile(info.filePath, info.mimeType);
        console.log(`[dify_provider]   OK, file_id=${fileId}`);
        fileIds.push({
          transfer_method: 'local_file',
          upload_file_id: fileId,
          type: (info.mimeType || '').startsWith('image/') ? 'image' : 'document',
          filename: info.filename,
        });
      }
      // file: 单值;file_array: 数组
      uploaded[cfg.varName] = cfg.type === 'file' ? fileIds[0] : fileIds;
    }
    Object.assign(inputs, uploaded);

    console.log(`[dify_provider] 调用工作流, inputs keys=${Object.keys(inputs).join(',')}`);

    // 3. 调用工作流
    const result = await this.runWorkflow(inputs);

    // 4. 按 outputPath 提取输出,返回给 promptfoo
    //    如果不配 outputPath 或提取失败,返回完整响应字符串(便于断言脚本自己解析)
    const extracted = this.extractByPath(result, this.outputPath);
    return {
      output: extracted !== undefined ? String(extracted) : JSON.stringify(result),
      // 同时把完整响应挂在 metadata 上,断言脚本可通过 context 取到(如需原始结构)
      metadata: { rawResponse: result, outputPath: this.outputPath },
    };
  }

  // ===== 按路径(如 "data.outputs.output")从对象取值 =====
  extractByPath(obj, pathStr) {
    if (!pathStr) return undefined;
    let cur = obj;
    for (const key of pathStr.split('.')) {
      if (cur === null || cur === undefined) return undefined;
      cur = cur[key];
    }
    return cur;
  }

  // ===== 读取本地文件并上传到 Dify =====
  async uploadFile(filePath, mimeType) {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const boundary = '----FormBoundary' + Math.random().toString(16).substring(2);

    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`));
    parts.push(Buffer.from(`Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(Buffer.from(`\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="user"\r\n\r\n`));
    parts.push(Buffer.from(`${this.user}\r\n`));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    const url = new URL(this.baseUrl + '/files/upload');
    const data = await this.httpRequest(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, body);

    const fileId = data.id;
    if (!fileId) {
      throw new Error(`上传未返回 file_id,响应: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return fileId;
  }

  // ===== 调用工作流 =====
  runWorkflow(inputs) {
    const payload = JSON.stringify({
      inputs,
      response_mode: 'blocking',
      user: this.user,
    });

    const url = new URL(this.baseUrl + '/workflows/run');
    return this.httpRequest(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, payload);
  }

  // ===== 通用 HTTP 请求(带 429 重试) =====
  httpRequest(url, options, body) {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const doRequest = (attempt) => {
        const req = lib.request(url, options, (res) => {
          let chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            // 429 限流:按 Retry-After 退避重试,最多 3 次
            if (res.statusCode === 429 && attempt < 3) {
              const retryAfter = parseInt(res.headers['retry-after'] || '30', 10);
              console.error(`[dify_provider] 429 限流,${retryAfter}s 后重试(第${attempt + 1}次)...`);
              setTimeout(() => doRequest(attempt + 1), retryAfter * 1000);
              return;
            }
            let data;
            try {
              data = raw ? JSON.parse(raw) : {};
            } catch (e) {
              data = { _raw: raw };
            }
            if (res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 500)}`));
              return;
            }
            resolve(data);
          });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
      };
      doRequest(0);
    });
  }
}

// 关键:默认导出类,promptfoo 会 new 这个类
module.exports = DifyWorkflowProvider;
