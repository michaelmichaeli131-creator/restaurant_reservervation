const path = 'templates/owner_hours.eta';
let source = await Deno.readTextFile(path);
if(!source.includes('owner-hours-validation.js')) {
  const old = 'const opts = [30,45,60,75,90,105,120,135,150,165,180,195,210,225,240];';
  if(!source.includes(old)) throw new Error('Hours duration selector hook missing');
  source = source.replace(old, 'const opts = [...new Set([15,30,45,60,75,90,105,120,135,150,165,180,195,210,225,240,...(Number.isInteger(d) && d >= 15 && d <= 240 ? [d] : [])])].sort((a,b)=>a-b);');
  source += '\n<script defer src="/public/js/owner-hours-validation.js?v=20260929-5"></script><style>.hours-save-feedback{grid-column:1/-1;color:#fbbf24;line-height:1.6}.sb-hours [aria-invalid="true"]{outline:2px solid #f87171;outline-offset:2px}@media(max-width:760px){.sb-hours input,.sb-hours select{font-size:16px!important}.sb-hours .form-actions button{min-height:44px}}</style>';
  await Deno.writeTextFile(path,source);
}
