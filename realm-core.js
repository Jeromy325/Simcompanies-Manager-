import {R1_REALM} from './realm-r1.js';
import {R2_REALM} from './realm-r2.js';

export const REALM_DEFINITIONS = Object.freeze({0:R1_REALM,1:R2_REALM});

export function validRealmNumber(value){
  if(value===null||value===undefined||value==='')return null;
  const n=Number(value);
  return Number.isFinite(n)&&Object.prototype.hasOwnProperty.call(REALM_DEFINITIONS,n)?n:null;
}

export function realmDefinition(realm){
  const n=validRealmNumber(realm);
  return n==null?null:REALM_DEFINITIONS[n];
}

export function realmKeyFromRealm(realm){return realmDefinition(realm)?.key||null;}
export function realmStorageKey(realm){return realmDefinition(realm)?.storageKey||null;}
export function realmDisplayNumber(realm){return realmDefinition(realm)?.display||null;}
export function realmDisplayName(realm){const d=realmDefinition(realm);return d?`${d.display} - ${d.name}`:null;}
export function realmContractPaths(realm){return realmDefinition(realm)?.contractPaths||[];}
