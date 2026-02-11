# Deferred Improvements

This document lists code quality improvements that were identified during the hardening pass but were deemed **too risky** to implement without extensive testing. These improvements would be valuable but require careful planning and validation.

## High-Value, High-Risk Improvements

### 1. Refactor App.tsx into Smaller Components

**What:** The main `App.tsx` file is 221KB and contains all game logic in a single monolithic component.

**Why it would help:**
- Easier to understand and maintain
- Better test coverage of individual components
- Reduced re-render scope
- Easier to identify performance bottlenecks

**Why it's risky now:**
- High chance of introducing subtle state management bugs
- Keyboard event handling is complex and intertwined with game state
- Audio synchronization with visual effects is delicate
- Extensive testing would be required for all game modes and edge cases
- Risk of breaking the working user experience for toddlers

**Recommended approach (future):**
1. Add comprehensive E2E tests first (Playwright or Cypress)
2. Extract non-interactive components first (Settings panels, Results screen)
3. Extract game logic into custom hooks (useGameState, useKeyboardHandler, useAudioPlayer)
4. Move to presentational components for visual effects
5. Test extensively in all modes (learning, time contest, task contest, all levels)

---

### 2. Add React Error Boundaries

**What:** Wrap key sections of the app in error boundaries to prevent white screens.

**Why it would help:**
- Graceful degradation if a component crashes
- Better error reporting
- Prevents entire app from crashing

**Why it's risky now:**
- The current monolithic App.tsx makes error boundary placement unclear
- Risk of hiding important bugs that should be fixed
- Need to define fallback UI that makes sense for toddlers
- Requires refactoring to split components first (see #1)

**Recommended approach (future):**
- Implement after component refactoring
- Add boundaries around: Settings modal, Game screen, Results screen, Admin panels
- Create toddler-friendly error fallback (big colorful "Oops!" screen with restart button)

---

### 3. Migrate to TypeScript (Server)

**What:** Convert server code from plain JavaScript to TypeScript.

**Why it would help:**
- Type safety for database queries and API contracts
- Better IDE autocomplete and refactoring support
- Catch bugs at compile time instead of runtime

**Why it's risky now:**
- Server is 10+ files with complex database adapters (SQLite + PostgreSQL)
- Need to define types for all DB schemas, migrations, and API responses
- Risk of introducing bugs during conversion
- Would require extensive testing of all API endpoints and database operations
- Setup mode, admin flows, and auth need careful validation

**Recommended approach (future):**
1. Start with isolated modules (e.g., `src/shared/errors.js`)
2. Add `.d.ts` declaration files for gradual migration
3. Use `allowJs` and `checkJs` to incrementally add type checking
4. Convert infrastructure layer first (config, encryption, email)
5. Then domain layer (RBAC, auth), then application layer, then routes

---

### 4. Harden Production Deployment Defaults

**What:** Remove hardcoded weak credentials from docker-compose.yml.

**Why it would help:**
- Forces operators to set proper credentials
- Prevents accidental production deployments with weak passwords
- Security best practice

**Why it's risky now:**
- Breaking change for local development workflow
- Could break existing deployments that rely on defaults
- Need to update all deployment documentation
- Requires coordination with deployment process

**Current mitigation:**
- Added clear WARNING comments in docker-compose.yml
- .env.example has proper empty placeholders
- README and INSTALL.md document security requirements

**Recommended approach (future):**
- Create separate `docker-compose.dev.yml` with weak defaults for local dev
- Production `docker-compose.yml` requires all secrets via env vars
- Add validation script that fails if weak defaults are detected in production
- Update deployment guide with security checklist

---

### 5. Add Integration Tests for Game Logic

**What:** Add E2E tests that simulate toddler interactions.

**Why it would help:**
- Confidence when refactoring
- Regression prevention
- Documentation of expected behavior

**Why it's risky now:**
- Requires test infrastructure setup (Playwright/Cypress)
- Need to mock audio playback (browser autoplay policies)
- Need to test keyboard events across different browsers
- Time investment vs. immediate value (app already works)

**Recommended approach (future):**
1. Add Playwright or Cypress
2. Test critical flows: start game → press keys → complete task → see effects
3. Test all game modes and levels
4. Test function key protection
5. Test language mismatch detection
6. Test audio mute/volume controls

---

### 6. Performance Optimization

**What:** Profile and optimize render performance, especially for rapid key presses.

**Why it would help:**
- Better responsiveness for fast typists (or toddlers smashing keys)
- Lower CPU usage
- Better battery life on tablets

**Why it's risky now:**
- Need to profile first to identify actual bottlenecks
- Premature optimization without data
- Risk of over-engineering
- Current performance seems acceptable based on code review

**Recommended approach (future):**
1. Add React DevTools Profiler measurements
2. Measure render times during rapid key presses
3. Identify hot paths (likely: visual effect rendering, progress state updates)
4. Consider: React.memo for effect components, useTransition for non-urgent updates
5. Validate improvements with real usage data

---

### 7. Accessibility Audit

**What:** Full WCAG 2.1 accessibility audit and remediation.

**Why it would help:**
- Usable by children with disabilities
- Keyboard navigation for parents/admins
- Screen reader support for setup/admin screens

**Why it's risky now:**
- The game is deliberately visual/audio-focused for toddlers
- Screen reader support might conflict with keyboard training purpose
- Need to define accessibility goals (admin UI vs. game itself)
- Requires accessibility expertise

**Recommended approach (future):**
- Focus on admin/setup screens first (these should be fully accessible)
- Game screen accessibility is complex (keyboard events are the core mechanic)
- Add ARIA labels for settings controls
- Ensure all colors meet WCAG AA contrast ratios
- Test with screen readers and keyboard-only navigation

---

### 8. Dependency Audit and Updates

**What:** Update dependencies to latest versions and audit for vulnerabilities.

**Why it would help:**
- Security patches
- Bug fixes
- New features

**Why it's risky now:**
- Major version updates can introduce breaking changes
- React 18 → 19, Vite 5 → 6, Mantine 7 → 8 all have migration guides
- Need to test entire app after updates
- Risk of subtle behavior changes

**Recommended approach (future):**
1. Run `npm audit` and address high/critical vulnerabilities first
2. Update patch versions only (e.g., 7.13.0 → 7.13.5)
3. Test thoroughly
4. Plan major updates separately with dedicated testing time
5. Read migration guides before upgrading

---

## Low-Priority Improvements

### 9. Add Loading States
- Show spinner/skeleton during API calls
- Current approach is functional (errors show messages)

### 10. Internationalization (i18n)
- UI is in English; game supports multiple language packs
- Full i18n would require translation of all UI strings

### 11. PWA / Offline Support
- Game requires server for auth and leaderboard
- Offline mode would need service worker and local storage strategy

---

## Notes

All improvements above were skipped during the hardening pass to prioritize **stability and safety**. The application works well in its current form. These improvements should be tackled one at a time with proper testing and user validation.

**Remember:** A working app with messy code is infinitely better than clean code that doesn't work.
