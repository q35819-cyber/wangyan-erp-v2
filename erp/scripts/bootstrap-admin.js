#!/usr/bin/env node
'use strict';

// A deliberately one-shot initial admin bootstrap for an EMPTY community database.
// Never use this command on a database that has real users, tenants or business data.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const help='用法：先在全新本机wyerp_community_*数据库完成全部迁移，随后设置临时环境变量WYERP_BOOTSTRAP_ADMIN_PASSWORD（至少12位），运行node scripts/bootstrap-admin.js --confirm-empty-database。只允许首次空库创建唯一admin，不更新现有账号。';
async function main(){
 const args=process.argv.slice(2);
 if(args.includes('--help')||args.includes('-h')){console.log(help);return;}
 if(args.length!==1||args[0]!=='--confirm-empty-database')throw new Error('必须显式指定--confirm-empty-database。'+help);
 const database=String(process.env.PGDATABASE||'');
 const hostname=String(process.env.PGHOST||'');
 if(!/^wyerp_community_[a-z0-9_]+$/.test(database)||!['127.0.0.1','localhost','::1'].includes(hostname)){
  throw new Error('拒绝连接非社区隔离的本机数据库。PGDATABASE必须是wyerp_community_*，PGHOST仅允许回环地址');
 }
 if(process.env.DATABASE_URL||process.env.DATABASE_MIGRATION_URL){
  throw new Error('首次建admin不接受DATABASE_URL。请只提供明确的本机PGHOST、PGDATABASE和PGMIGRATIONUSER');
 }
 if(!process.env.PGMIGRATIONUSER || !process.env.PGMIGRATIONPASSWORD){
  throw new Error('必须提供本次新建数据库的迁移专用PG账号和密码');
 }
 const password=String(process.env.WYERP_BOOTSTRAP_ADMIN_PASSWORD||'');
 delete process.env.WYERP_BOOTSTRAP_ADMIN_PASSWORD;
 if(password.length<12||password.length>128||password.toLowerCase()==='admin'||password.toLowerCase()==='password'){
  throw new Error('新管理员口令至少12位，不能使用默认弱口令；不会把明文写入数据库或Git');
 }
 const {Client}=require('pg');
 const {createDatabaseConfig}=require('../db/config');
 const {hashPassword}=require('../auth/password');
 const conn=createDatabaseConfig({migration:true});
 if(conn.connectionString)throw new Error('拒绝通过动态URL初始化admin');
 const client=new Client(conn);
 await client.connect();
 let begun=false;
 try{
  await client.query('BEGIN');begun=true;
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['wyerp:initial-admin-bootstrap']);
  const actual=await client.query('SELECT current_database() AS name');
  if(actual.rows[0].name!==database)throw new Error('数据库连接不匹配指定的全新数据库');
  const schema=await client.query("SELECT to_regclass('public.schema_migrations') AS name");
  if(!schema.rows[0].name)throw new Error('Schema尚未初始化，请先运行db/migrate.js');
  const recorded=await client.query('SELECT version,checksum_sha256 FROM schema_migrations');
  const recordedHashes=new Map(recorded.rows.map(r=>[r.version,r.checksum_sha256]));
  const dir=path.join(__dirname,'../db/migrations');
  const files=fs.readdirSync(dir).filter(n=>/^[0-9]{3,}_[a-z0-9_-]+\.sql$/i.test(n));
  if(files.length<50 || recordedHashes.size!==files.length)throw new Error('数据库迁移数量不完整，不能初始化管理员');
  for(const file of files){
   const content=fs.readFileSync(path.join(dir,file),'utf8').replace(/\r\n/g,'\n');
   const sum=crypto.createHash('sha256').update(content).digest('hex');
   if(recordedHashes.get(file)!==sum)throw new Error('数据库迁移版本或校验码不匹配：'+file);
  }
  const count=await client.query('SELECT (SELECT count(*)::integer FROM users) AS users, (SELECT count(*)::integer FROM tenants) AS tenants, (SELECT count(*)::integer FROM tenant_members) AS memberships');
  const c=count.rows[0];
  if(c.users!==0||c.tenants!==0||c.memberships!==0){
   throw new Error('数据库已有用户、租户或成员关系！禁止执行初始admin创建，也不会更改现有密码');
  }
  const encoded=await hashPassword(password);
  const user=await client.query(
   "INSERT INTO users(username,password_hash,password_algorithm,status,is_system_admin) VALUES('admin',$1,'scrypt','active',true) RETURNING id",
   [encoded]
  );
  const adminId=user.rows[0].id;
  const slug='system-admin-home-'+crypto.randomBytes(7).toString('hex');
  const tenant=await client.query(
   "INSERT INTO tenants(slug,name,status) VALUES($1,'系统管理','active') RETURNING id",
   [slug]
  );
  await client.query(
   "INSERT INTO tenant_members(tenant_id,user_id,member_type,status,shop_scope_mode,display_name,created_by_user_id,joined_at) VALUES($1,$2,'owner','active','all','系统管理员',$2,now())",
   [tenant.rows[0].id,adminId]
  );
  const confirm=await client.query(
   "SELECT count(*)::integer AS count FROM users u JOIN tenant_members tm ON tm.user_id=u.id JOIN tenants t ON t.id=tm.tenant_id WHERE u.username='admin' AND u.is_system_admin=true AND t.name='系统管理' AND tm.member_type='owner' AND tm.shop_scope_mode='all'"
  );
  if(confirm.rows[0].count!==1)throw new Error('admin校验未通过，回滚全部更改');
  await client.query('COMMIT');begun=false;
  console.log('PASS 已仅在全新空库创建唯一admin系统管理员与系统管理租户。');
  console.log('NEXT 在本机登录页面以admin与刚才设置的密码登录。请勿保存此密码到仓库。');
 }catch(e){if(begun)await client.query('ROLLBACK');throw e}
 finally{await client.end()}
}
main().catch(e=>{
 console.error('FAIL 初始化被拒绝：'+String(e.message||e).slice(0,280));
 process.exitCode=1;
});