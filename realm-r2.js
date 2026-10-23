// R2 - Entrepreneurs realm definition.
// Realm-specific configuration lives here; shared behavior stays in realm-core.js/background.js.
export const R2_REALM = Object.freeze({
  id: 1,
  apiId: 1,
  key: 'realm:1',
  display: 'R2',
  name: 'Entrepreneurs',
  storageKey: 'scmRealmStore:1',
  contractPaths: ['/api/v3/contracts-incoming/1/me/', '/api/v3/contracts-outgoing/me/']
});
