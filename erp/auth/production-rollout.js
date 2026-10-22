'use strict';

const fs = require('fs');

function inspectRolloutPolicy(file) {
  const issues = [];
  if (!file || !fs.existsSync(file)) return { ok:false, issues:[{code:'rollout_policy',message:'缺少灰度放量策略文件'}] };
  let policy;
  try { policy = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { ok:false, issues:[{code:'rollout_policy_json',message:`灰度策略 JSON 无效: ${error.message}`}] }; }
  const maxInvitedUsers = Number(policy.maxInvitedUsers);
  if (!Number.isInteger(maxInvitedUsers) || maxInvitedUsers < 1 || maxInvitedUsers > 50) issues.push({code:'max_invited_users',message:'第一阶段邀请灰度人数必须为 1-50'});
  if (policy.openRegistration !== false) issues.push({code:'open_registration',message:'第一阶段灰度必须关闭公开注册'});
  if (policy.realCharging !== false) issues.push({code:'real_charging',message:'第一阶段灰度必须关闭真实收费'});
  if (policy.agentAutoPenalty !== false) issues.push({code:'agent_auto_penalty',message:'第一阶段灰度必须关闭代理自动处罚'});
  if (policy.requireInviteCode !== true) issues.push({code:'invite_code',message:'第一阶段灰度必须要求邀请资格'});
  if (policy.stopOnP0P1 !== true) issues.push({code:'stop_on_p0_p1',message:'灰度策略必须声明 P0/P1 回归立即停止放量'});
  const stages = Array.isArray(policy.stages) ? policy.stages : [];
  if (!stages.length) issues.push({code:'stages',message:'灰度策略至少需要一个阶段'});
  let previous = 0;
  for (const [index, stage] of stages.entries()) {
    const users = Number(stage && stage.users);
    if (!Number.isInteger(users) || users <= previous || users > maxInvitedUsers) issues.push({code:'stage_users',message:`第 ${index + 1} 阶段用户数必须递增且不超过总上限`});
    previous = users;
    const observeHours = Number(stage && stage.observeHours);
    if (!Number.isFinite(observeHours) || observeHours < 1) issues.push({code:'stage_observation',message:`第 ${index + 1} 阶段观察时间至少 1 小时`});
  }
  return { ok:issues.length===0, issues, policy };
}

function main() {
  const file = process.env.ERP_ROLLOUT_POLICY;
  const result = inspectRolloutPolicy(file);
  if (!result.ok) {
    console.error('[production-rollout] FAIL');
    for (const issue of result.issues) console.error(`- ${issue.code}: ${issue.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[production-rollout] PASS maxInvitedUsers=${result.policy.maxInvitedUsers} stages=${result.policy.stages.length}`);
}

if (require.main === module) main();
module.exports = { inspectRolloutPolicy };
