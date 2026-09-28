// Run after generated booking templates; fail the build if the expected pages disappear.
for(const name of ["restaurant","reservation_details","reservation_confirmed","calendar_waitlist_guest"]){
  const file="templates/"+name+".eta";
  let source=await Deno.readTextFile(file);
  if(source.includes("spotbook-customer-mobile.css"))continue;
  source+='\n<link rel="stylesheet" href="/public/css/spotbook-customer-mobile.css?v=20260929-2">\n<script defer src="/public/js/spotbook-customer-mobile.js?v=20260929-2"></script>\n';
  source=source.replace('/public/js/restaurant_gallery.js"', '/public/js/restaurant_gallery.js?v=20260929-2"').replace('/public/js/menu_embed.js"', '/public/js/menu_embed.js?v=20260929-2"');
  await Deno.writeTextFile(file,source);
}
console.log("Customer mobile gallery, menu and form refinements enabled");
