'use strict';

const nodemailer = require('nodemailer');

function clean(value, maximum) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function multiline(value, maximum) {
  return String(value == null ? '' : value).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maximum);
}

function html(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function createBugMailer(options = {}) {
  const env = options.env || process.env;
  const recipient = clean(env.BUG_REPORT_EMAIL, 240);
  const user = clean(env.SMTP_USER, 240);
  const password = String(env.SMTP_PASS || '');
  const from = clean(env.SMTP_FROM || user, 240);
  const configured = Boolean(options.transporter || (recipient && user && password && from));
  let transporter = options.transporter || null;

  function transport() {
    if (!transporter) {
      const port = Number(env.SMTP_PORT || 465);
      transporter = nodemailer.createTransport({
        pool: true,
        host: clean(env.SMTP_HOST || 'smtp.qq.com', 240),
        port,
        secure: String(env.SMTP_SECURE == null ? port === 465 : env.SMTP_SECURE) !== 'false',
        auth: { user, pass: password },
        maxConnections: 2,
        maxMessages: 50,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
        disableFileAccess: true,
        disableUrlAccess: true
      });
    }
    return transporter;
  }

  async function send(report, actor) {
    if (!configured) return { sent: false, reason: 'smtp_not_configured', recipient };
    report = report && typeof report === 'object' ? report : {};
    const title = clean(report.title, 120) || '未命名问题';
    const severity = clean(report.severity, 20) === 'high' ? '严重' : clean(report.severity, 20) === 'low' ? '轻微' : '一般';
    const attachmentRows = (Array.isArray(report.attachments) ? report.attachments : []).slice(0, 6).map(item => {
      const name = clean(item && item.name, 160) || '附件';
      const relativeUrl = clean(item && item.url, 360);
      const url = options.publicOrigin && relativeUrl.startsWith('/') ? options.publicOrigin + relativeUrl : '';
      return { name, url };
    });
    const values = {
      id: clean(report.id, 80), title, severity, module: clean(report.module, 40) || '其他',
      page: clean(report.page, 240) || '未填写', description: multiline(report.description, 2000) || '未填写',
      steps: multiline(report.steps, 2000) || '未填写', expected: multiline(report.expected, 1000) || '未填写',
      actor: clean(actor && (actor.displayName || actor.username), 160) || '未知用户',
      createdAt: clean(report.createdAt, 80) || new Date().toISOString()
    };
    const attachmentText = attachmentRows.length ? attachmentRows.map(item => '- ' + item.name + (item.url ? ': ' + item.url : '')).join('\n') : '无';
    const text = [
      '网研ERP 收到新的 BUG 反馈', '',
      '编号：' + values.id, '标题：' + values.title, '严重程度：' + values.severity,
      '所属模块：' + values.module, '问题页面：' + values.page, '提交用户：' + values.actor,
      '提交时间：' + values.createdAt, '', '实际问题：', values.description, '',
      '复现步骤：', values.steps, '', '期望结果：', values.expected, '', '附件：', attachmentText
    ].join('\n');
    const attachmentHtml = attachmentRows.length
      ? '<ul>' + attachmentRows.map(item => '<li>' + (item.url ? '<a href="' + html(item.url) + '">' + html(item.name) + '</a>' : html(item.name)) + '</li>').join('') + '</ul>'
      : '<p>无</p>';
    const messageHtml = '<div style="font-family:Arial,Microsoft YaHei,sans-serif;color:#243447;line-height:1.7">' +
      '<h2 style="color:#173d67">网研ERP 收到新的 BUG 反馈</h2>' +
      '<table cellpadding="7" cellspacing="0" style="border-collapse:collapse"><tbody>' +
      [['编号', values.id], ['标题', values.title], ['严重程度', values.severity], ['所属模块', values.module], ['问题页面', values.page], ['提交用户', values.actor], ['提交时间', values.createdAt]]
        .map(row => '<tr><td style="color:#6b7c8f;white-space:nowrap">' + html(row[0]) + '</td><td>' + html(row[1]) + '</td></tr>').join('') +
      '</tbody></table><h3>实际问题</h3><p style="white-space:pre-wrap">' + html(values.description) + '</p>' +
      '<h3>复现步骤</h3><p style="white-space:pre-wrap">' + html(values.steps) + '</p>' +
      '<h3>期望结果</h3><p style="white-space:pre-wrap">' + html(values.expected) + '</p><h3>附件</h3>' + attachmentHtml + '</div>';

    const info = await transport().sendMail({
      from: '网研ERP BUG反馈 <' + from + '>',
      to: recipient,
      subject: '[网研ERP BUG][' + severity + '] ' + title,
      text,
      html: messageHtml,
      disableFileAccess: true,
      disableUrlAccess: true
    });
    return { sent: true, recipient, messageId: clean(info && info.messageId, 240) };
  }

  async function sendSystemAlert(title, introduction, rows) {
    if (!configured) return { sent: false, reason: 'smtp_not_configured', recipient };
    const safeTitle = clean(title, 140) || '系统监控告警';
    const safeIntroduction = multiline(introduction, 2000) || '系统检测到需要处理的异常。';
    const safeRows = (Array.isArray(rows) ? rows : []).slice(0, 100).map(row => ({
      name: clean(row && row.name, 180), endpoint: clean(row && row.endpoint, 300),
      purpose: clean(row && row.purpose, 500), reason: clean(row && row.reason, 800),
      attempts: Math.max(0, Number(row && row.attempts) || 0), lastCheckedAt: clean(row && row.lastCheckedAt, 80)
    }));
    const text = [safeTitle, '', safeIntroduction, ''].concat(safeRows.map((row, index) => [
      `${index + 1}. ${row.name}`, `接口：${row.endpoint}`, `用途：${row.purpose}`,
      `原因：${row.reason}`, `连续失败：${row.attempts} 次`, `最后检测：${row.lastCheckedAt}`
    ].join('\n'))).join('\n\n');
    const bodyRows = safeRows.map((row, index) => '<tr>' +
      '<td style="padding:7px;border:1px solid #d8e1ea">' + (index + 1) + '</td>' +
      '<td style="padding:7px;border:1px solid #d8e1ea">' + html(row.name) + '</td>' +
      '<td style="padding:7px;border:1px solid #d8e1ea">' + html(row.endpoint) + '</td>' +
      '<td style="padding:7px;border:1px solid #d8e1ea">' + html(row.purpose) + '</td>' +
      '<td style="padding:7px;border:1px solid #d8e1ea;color:#b42318">' + html(row.reason) + '</td>' +
      '<td style="padding:7px;border:1px solid #d8e1ea">' + row.attempts + '</td></tr>').join('');
    const messageHtml = '<div style="font-family:Arial,Microsoft YaHei,sans-serif;color:#243447;line-height:1.7">' +
      '<h2 style="color:#173d67">' + html(safeTitle) + '</h2><p style="white-space:pre-wrap">' + html(safeIntroduction) + '</p>' +
      '<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%"><thead><tr>' +
      ['序号', '接口名称', '接口地址', '用途', '失败原因', '次数'].map(value => '<th style="padding:7px;border:1px solid #d8e1ea;background:#eef4fa">' + value + '</th>').join('') +
      '</tr></thead><tbody>' + bodyRows + '</tbody></table></div>';
    const info = await transport().sendMail({
      from: '网研ERP 系统监控 <' + from + '>', to: recipient, subject: '[网研ERP 接口告警] ' + safeTitle,
      text, html: messageHtml, disableFileAccess: true, disableUrlAccess: true
    });
    return { sent: true, recipient, messageId: clean(info && info.messageId, 240) };
  }

  async function sendSecurityAlert(target, title, message) {
    const to = clean(target, 240);
    if (!configured) return { sent: false, reason: 'smtp_not_configured', recipient: to || recipient };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { sent: false, reason: 'invalid_recipient', recipient: to };
    const safeTitle = clean(title, 140) || '账号安全提醒';
    const safeMessage = multiline(message, 4000) || '系统检测到账号安全异常。';
    const info = await transport().sendMail({
      from: '网研ERP 安全监控 <' + from + '>', to,
      subject: '[网研ERP 安全提醒] ' + safeTitle,
      text: safeTitle + '\n\n' + safeMessage,
      html: '<div style="font-family:Arial,Microsoft YaHei,sans-serif;color:#243447;line-height:1.8"><h2 style="color:#9f2d20">' +
        html(safeTitle) + '</h2><p style="white-space:pre-wrap">' + html(safeMessage) + '</p></div>',
      disableFileAccess: true, disableUrlAccess: true
    });
    return { sent: true, recipient: to, messageId: clean(info && info.messageId, 240) };
  }

  async function sendEmailVerificationCode(target, code, minutes) {
    const to = clean(target, 240);
    if (!configured) return { sent: false, reason: 'smtp_not_configured', recipient: to };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { sent: false, reason: 'invalid_recipient', recipient: to };
    const safeCode = clean(code, 8).replace(/\D/g, '');
    if (!/^\d{6}$/.test(safeCode)) return { sent: false, reason: 'invalid_code', recipient: to };
    const validMinutes = Math.max(1, Number(minutes) || 10);
    const info = await transport().sendMail({
      from: '网研ERP 账号验证 <' + from + '>', to,
      subject: '[网研ERP] 邮箱验证码 ' + safeCode,
      text: '您正在绑定网研ERP账号的邮箱。\n\n验证码：' + safeCode + '\n有效期：' + validMinutes + ' 分钟。\n\n如果不是本人操作，请忽略本邮件，并检查账号密码。',
      html: '<div style="font-family:Arial,Microsoft YaHei,sans-serif;color:#243447;line-height:1.8">' +
        '<h2 style="color:#173d67">网研ERP 邮箱验证</h2><p>您正在绑定网研ERP账号的邮箱。</p>' +
        '<p style="font-size:26px;font-weight:700;letter-spacing:6px;color:#9a682f">' + safeCode + '</p>' +
        '<p>有效期：' + validMinutes + ' 分钟。如果不是本人操作，请忽略本邮件，并检查账号密码。</p></div>',
      disableFileAccess: true, disableUrlAccess: true
    });
    return { sent: true, recipient: to, messageId: clean(info && info.messageId, 240) };
  }

  return { configured, recipient, send, sendSystemAlert, sendSecurityAlert, sendEmailVerificationCode };
}

module.exports = { createBugMailer };
