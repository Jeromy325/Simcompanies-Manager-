// R1 - Magnates realm definition.
// Realm-specific configuration lives here; shared behavior stays in realm-core.js/background.js.
export const R1_REALM = Object.freeze({
  id: 0,
  apiId: 0,
  key: 'realm:0',
  display: 'R1',
  name: 'Magnates',
  storageKey: 'scmRealmStore:0',
  contractPaths: ['/api/v3/contracts-incoming/0/me/', '/api/v3/contracts-outgoing/me/']
});
