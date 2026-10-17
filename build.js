// 把前端 HTML 内联进 worker，输出单文件 dist/index.js
const fs = require('fs');
const path = require('path');
const dir = __dirname;
let worker = fs.readFileSync(path.join(dir, 'src/worker.js'), 'utf8');
let html = fs.readFileSync(path.join(dir, 'src/app.html'), 'utf8');
// 注入命令数据库和题库到 <script> 开头
const cmdDb = fs.readFileSync(path.join(dir, 'src/cmd-db.js'), 'utf8');
const quizDb = fs.readFileSync(path.join(dir, 'src/quiz-db.js'), 'utf8');
html = html.replace('<script>', '<script>\n' + cmdDb + '\n' + quizDb);
worker = worker.replace('const APP_HTML = "__APP_HTML__";', 'const APP_HTML = ' + JSON.stringify(html) + ';');
fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
fs.writeFileSync(path.join(dir, 'dist/index.js'), worker);
console.log('built dist/index.js', Buffer.byteLength(worker), 'bytes');
