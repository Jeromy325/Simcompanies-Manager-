#!/usr/bin/env bash
cd "$(dirname "$0")/.."; f=0; n=0
for t in tests/*.test.js; do n=$((n+1)); node "$t" >/tmp/t.log 2>&1 || { f=$((f+1)); echo "FAIL $t"; tail -5 /tmp/t.log; }; done
for j in $(git ls-files '*.js'); do node --check "$j" 2>&1 | head -3; done
npx -y -p typescript tsc --allowJs --checkJs --noEmit --target es2022 --module es2022 --lib es2022,dom $(git ls-files '*.js' | grep -v '^tests/') 2>&1 | grep -E 'TS2304|TS2552' | grep -vE "'(chrome|SCM_DIAGNOSTIC_CORE)'" | head -20
grep -nE 'on[a-z]+="' *.html *.js | head
echo "tests: $((n-f))/$n passed"
