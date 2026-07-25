/**
 * Dify 工作流 Custom Provider for promptfoo
 *
 * 解决问题：file_id 会失效，CI 无人值守无法手工重传。
 * 方案：每次执行用例时，实时上传本地图片到 Dify，立即调用工作流。
 *
 * 配置在 promptfooconfig.yaml 中：
 *   providers:
 *     - id: file://providers/dify_workflow.js
 *       config:
 *         baseUrl: http://dify.mycompany.com:5001/v1
 *         apiKey: app-XPq48gGyWQJ9B8D7ufqOQfaA
 *         user: abc-123
 *         inputVarName: input_picture
 *
 * 每个 test 用例的 vars 里需提供：
 *   filename: input-001.jpg   （本地图片文件名，相对 inputs/ 目录）
 *
 * promptfoo 会 new 本模块导出的类，并调用其 callApi 方法。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

class DifyWorkflowProvider {
  constructor(providerOptions = {}) {
    // promptfoo 传入的是 { config: {...}, id, label, ... }，真正配置在 config 字段下
    const config = providerOptions.config || providerOptions;
    this.config = config;
    this.providerId = providerOptions.id || 'dify_workflow';
    this.baseUrl = (config.baseUrl || process.env.DIFY_BASE_URL || '').replace(/\/$/, '');
    this.apiKey = config.apiKey || process.env.DIFY_API_KEY;
    this.user = config.user || process.env.DIFY_USER || 'abc-123';
    this.inputVarName = config.inputVarName || 'input_picture';
    this.imagesDir = config.imagesDir
      ? path.resolve(config.imagesDir)
      : path.join(__dirname, '..', 'inputs');

    if (!this.baseUrl || !this.apiKey) {
      throw new Error('DifyWorkflowProvider: 缺少 baseUrl 或 apiKey，请在 provider config 或环境变量中配置');
    }
  }

  // promptfoo 要求：返回 provider 标识
  id() {
    return this.providerId;
  }

  toString() {
    return `[Dify Workflow Provider ${this.providerId}]`;
  }

  // promptfoo 调用入口
  async callApi(prompt, context = {}, options = {}) {
    const filename = context.vars && context.vars.filename;
    if (!filename) {
      throw new Error('用例 vars 缺少 filename 字段');
    }
    const filePath = path.join(this.imagesDir, filename);
    if (!fs.existsSync(filePath)) {
      throw new Error(`图片文件不存在: ${filePath}`);
    }

    console.log(`[dify_provider] 处理 ${filename}: 上传 -> 调用工作流`);

    // 1. 上传
    const fileId = await this.uploadFile(filePath);
    console.log(`[dify_provider]   上传 OK, file_id=${fileId}`);

    // 2. 调用工作流
    const result = await this.runWorkflow(fileId, filename);

    // 返回完整 Dify 响应给 promptfoo（assertions.js 里会解析 data.outputs.output）
    return {
      output: JSON.stringify(result),
    };
  }

  // ===== 读取本地图片并上传到 Dify =====
  async uploadFile(filePath) {
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const boundary = '----FormBoundary' + Math.random().toString(16).substring(2);
    const mimeType = 'image/jpeg';

    const parts = [];
    parts.push(Buffer.from(`--${boundary}\r\n`));
    parts.push(Buffer.from(`Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`));
    parts.push(Buffer.from(`Content-Type: ${mimeType}\r\n\r\n`));
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
      throw new Error(`上传未返回 file_id，响应: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return fileId;
  }

  // ===== 调用工作流 =====
  async runWorkflow(fileId, fileName) {
    const payload = JSON.stringify({
      inputs: {
        [this.inputVarName]: [
          {
            transfer_method: 'local_file',
            upload_file_id: fileId,
            type: 'image',
            filename: fileName,
          },
        ],
      },
      response_mode: 'blocking',
      user: this.user,
    });

    const url = new URL(this.baseUrl + '/workflows/run');
    return await this.httpRequest(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, payload);
  }

  // ===== 通用 HTTP 请求（带 429 重试） =====
  httpRequest(url, options, body) {
    return new Promise((resolve, reject) => {
      const lib = url.protocol === 'https:' ? https : http;
      const doRequest = (attempt) => {
        const req = lib.request(url, options, (res) => {
          let chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            // 429 限流：按 Retry-After 退避重试，最多 3 次
            if (res.statusCode === 429 && attempt < 3) {
              const retryAfter = parseInt(res.headers['retry-after'] || '30', 10);
              console.error(`[dify_provider] 429 限流，${retryAfter}s 后重试(第${attempt + 1}次)...`);
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

// 关键：默认导出类，promptfoo 会 new 这个类
module.exports = DifyWorkflowProvider;
