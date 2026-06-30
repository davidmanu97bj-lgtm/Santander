const noop=()=>{};
const asyncTrue=async()=>true;
window.ExploraMileageControl=Object.freeze({disabled:true,refresh:async()=>null,open:()=>false,ensureBeforeBilling:asyncTrue,startReminder:noop,stopReminder:noop,scheduleReminder:noop,getStartGraceState:()=>({disabled:true}),getState:()=>({disabled:true,firebaseReady:false,storageReady:false}),parseNumber:value=>Number(value)||0,classify:()=>({disabled:true}),ensureFirebase:async()=>null,stableHash:value=>String(value||""),idempotentAlertId:()=>"",vehicleIsOperational:()=>true,canonicalAssignmentMatches:()=>true});
console.info("EXPLORA_LEGACY_WEEKLY_MILEAGE_CONTROL_DISABLED");
export {};
