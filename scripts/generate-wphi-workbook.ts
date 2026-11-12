import { mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import XLSX from 'xlsx';
import { createWphiDataset } from '../server/src/domain/wphi-demo';

const shanghaiDate = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const dataset=createWphiDataset(process.argv[2] ?? shanghaiDate);
const workbook=XLSX.utils.book_new();
const add=(name:string,rows:object[])=>XLSX.utils.book_append_sheet(workbook,XLSX.utils.json_to_sheet(rows),name);
add('日度总览',dataset.daily.map(({date,processedM3,informationCount,complianceRate})=>({date,processedM3,informationCount,complianceRate})));
add('出水水质',dataset.daily.map(({date,tn,ammonia,tp,cod,ss})=>({date,tn,ammonia,tp,cod,ss,tnLimit:3})));
add('能效费用',dataset.daily.map(({date,totalKwh,kwhPerM3,blowerKwh,carbonSourceKg,carbonEmissionKg,carbonReductionKg,savedYuan})=>({date,totalKwh,kwhPerM3,blowerKwh,carbonSourceKg,carbonEmissionKg,carbonReductionKg,savedYuan})));
add('健康指数',dataset.daily.map(({date,qualityScore,flowScore,energyScore,carbonSourceScore})=>({date,qualityScore,flowScore,energyScore,carbonSourceScore})));
add('预警记录',dataset.alerts);
add('WPHI输入',dataset.wphi!.history.slice(30).map(({date,tnIn,systemNormal})=>({date,tnIn,systemNormal})));
add('WPHI预热历史',dataset.wphi!.history.slice(0,30));
const path=resolve('data/污水处理厂_WPHI.xlsx');
mkdirSync(dirname(path),{recursive:true});
const temporaryPath = `${path}.${process.pid}.tmp.xlsx`;
XLSX.writeFile(workbook,temporaryPath);
renameSync(temporaryPath,path);
console.log(`WPHI workbook generated through ${dataset.daily.at(-1)!.date}: ${dataset.daily.length} display days, 30 warmup days`);
