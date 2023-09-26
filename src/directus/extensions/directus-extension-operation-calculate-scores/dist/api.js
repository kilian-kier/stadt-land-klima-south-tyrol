var t={id:"operation-calculateScores",handler:async({keys:t},{env:e,logger:a,accountability:i,services:o,getSchema:n,database:s})=>{try{const{ItemsService:e}=o,s=await n();a.info(i,"accountability"),a.info(t,"keys"),i.admin=!0;const r=new e("ratings_measures",{schema:s,accountability:i}),c=new e("measures",{schema:s,accountability:i}),l=new e("municipalities",{schema:s,accountability:i});let u={limit:-1};const m=await r.readMany(t,u),d=await c.readByQuery(u);a.info(m,"ratings_measures"),a.info(d,"measures");const f=Object.values(m).filter((t=>"published"===t.status)).map((t=>t.localteam_id));if(0===f.length)return void a.info("NOthing to recalc");const h={};m.forEach((t=>{const e=d.find((e=>e.id===t.measure_id));void 0!==e&&(h[e.sector]={denominator:0,numerator:0})})),h.total={denominator:0,numerator:0},a.info(f,"municipalitiesToRead"),a.info(h,"scoreDict"),u={filter:{localteam_id:{_in:f}}};const p=await l.readByQuery(u);a.info(p,"municipalities"),a.info(p[0],"municipalities0");for(const t of p){u={filter:{_and:[{localteam_id:{_eq:t.localteam_id}}]}};const e=await r.readByQuery(u);a.info(e,"allRatingsMeasures");let i=e.map((t=>{const e=d.find((e=>e.id===t.measure_id));return null!=e.weight&&null!=e.sector?(t.weight=e.weight,t.measureStatus=e.status,t.sector=e.sector):(t.weight=0,t.measureStatus="draft"),t}));a.info(i,"ratingsMeasureDetail");for(const t of i){const{applicable:e,measureStatus:a,weight:i,approved:o,status:n,rating:s,sector:r}=t;e&&"published"===a&&(h.total.denominator+=3*i,h[r]&&(h[r].denominator+=3*i),o&&"published"===n&&(h.total.numerator+=s*i,h[r]&&(h[r].numerator+=s*i)))}a.info(h,"scoreDict");let o={};for(const t in h)h.hasOwnProperty(t)&&(o["score_"+t]=h[t]=h[t].numerator/h[t].denominator,o["score_"+t]*="total"===t?100:10);a.info(o,"scoresToPush");await l.updateOne(t.id,o)}}catch(t){a.info(t)}return{}}};export{t as default};
