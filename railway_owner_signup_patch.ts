// Apply to the actual generated owner landing page; preserve all design layers.
const before="  const t = makePageAwareT(baseT, pageDict);";
const after="  // The owner landing page embeds the auth form alongside its own page copy.\n  const sharedAuthDict = template === \"for_restaurants\"\n    ? await tryLoadJson(pageDictFile(\"auth\", lang))\n    : null;\n  const t = makePageAwareT(makePageAwareT(baseT, sharedAuthDict), pageDict);";
let view=await Deno.readTextFile("lib/view.ts");
if(!view.includes(after)){
 if(!view.includes(before))throw new Error("Owner signup: unexpected renderer source");
 await Deno.writeTextFile("lib/view.ts",view.replace(before,after));
}
const fixTemplate=function fixTemplate(source,helper,css){
 if(source.includes('id="owner-signup-mobile-fix"'))return source;
 const re=/\(it\.t && it\.t\('(auth\.register\.[^']+)'\)\) \|\| ('[^']*')/g;
 let count=0;
 source=source.replace(re,(_,key,fallback)=>{count++;return `ownerSignupText('${key}', ${fallback})`;});
 if(count<15)throw new Error("Owner signup: expected translation fields missing");
 source=helper+source;
 const attrs={firstName:'autocomplete="given-name"',lastName:'autocomplete="family-name"',email:'autocomplete="email" inputmode="email" autocapitalize="off" spellcheck="false" dir="ltr"',password:'autocomplete="new-password"',confirm:'autocomplete="new-password"',phone:'autocomplete="tel" inputmode="tel" dir="ltr"'};
 for(const [name,attr]of Object.entries(attrs))source=source.replace(`name="${name}"`,`name="${name}" ${attr}`);
 return source+css;
};
const page="templates/for_restaurants.eta";
await Deno.writeTextFile(page,fixTemplate(await Deno.readTextFile(page),"<%\nfunction ownerSignupText(key, fallback) {\n  const value = typeof it.t === 'function' ? it.t(key) : '';\n  return !value || value === key || value === '(' + key + ')' ? fallback : value;\n}\n%>\n","\n<style id=\"owner-signup-mobile-fix\">\nhtml:has(#owner-signup),body:has(#owner-signup){height:auto;min-height:100%;overflow-x:clip}\n#owner-signup{scroll-margin-top:100px}\n#owner-signup .owners-field,#owner-signup .owners-signup-card,#owner-signup .owners-signup-form,#owner-signup .owners-signup__copy{min-width:0;overflow-wrap:anywhere}\n#owner-signup input,#owner-signup select{box-sizing:border-box;width:100%;min-width:0;font-size:16px;min-height:48px}\n#owner-signup input::placeholder{color:#94a3b8;opacity:1}\n#owner-signup .owners-signup-submit{min-height:50px;white-space:normal}\n@media(max-width:760px){\n#owner-signup .owners-signup__grid{grid-template-columns:minmax(0,1fr)}\n#owner-signup .owners-signup-card{padding:20px 16px;border-radius:20px}\n#owner-signup .owners-form-grid--two{grid-template-columns:minmax(0,1fr)}\n#owner-signup .owners-signup-form,#owner-signup .owners-form-grid{gap:18px}\n#owner-signup .owners-field>span{font-size:14px;line-height:1.5}\n}\n</style>\n"));
console.log("Embedded owner signup translations and mobile layout ready");
