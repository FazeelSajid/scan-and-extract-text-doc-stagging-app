# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

React Native 0.85.3 app (New Architecture + Hermes, Node ≥ 22.11.0) where a user photographs, picks or scans **any document** (ID card, CNIC, driving licence, passport, bank card, certificate, receipt, ...) and the app extracts its **expiration date** with OCR, then asks the user to confirm it. Targets Android (primary) and iOS.

OCR is **Google ML Kit** (`@react-native-ml-kit/text-recognition`) only. `react-native-nitro-ocr` and `@devinikhiya/react-native-tesseractocr` are still in `package.json` but nothing imports them; they lack the per-line bounding boxes the extractor needs and can be removed.

## Commands

All commands run from the repo root (the React Native project root, not a monorepo parent).

```bash
yarn install                # install JS deps
yarn start                  # Metro bundler
yarn android                # build + run Android (uses android/gradlew)
yarn ios                    # build + run iOS (uses bundler + Pods)
yarn lint                   # ESLint (extends @react-native config; root .eslintrc.js)
yarn test                   # Jest (preset @react-native/jest-preset)
yarn test expirationExtractor  # run one test file by name pattern
```

iOS first-time setup: `cd ios && bundle install && bundle exec pod install` (Gemfile pins cocoapods ≥ 1.13, excluding 1.15.0/1.15.1).

## Code Architecture

### `App.tsx` — UI shell
Single screen. State: `imageUri`, `status` (`idle | reading | done | error`), `extraction` (the `ExpirationExtraction`), `confirmed` (the date or "never expires" the user accepted) and the manual-entry editor (`editing`, `draft`).
- Choosing an image (camera, gallery or scanner) calls `processImage`, which runs ML Kit and `extractExpirationDate` immediately. Buttons are disabled while it runs; OCR errors show a "Try again" card.
- `react-native-image-picker`: `launchCamera` / `launchImageLibrary` with `PICKER_OPTIONS` (max 2500px). The gallery needs no permission (system photo picker). The camera requests Android `CAMERA` only if the picker returns `errorCode === 'permission'`, which happens when a library declares CAMERA in the merged manifest.
- `react-native-document-scanner-plugin` → `scanDocument`.
- Result card: shows `display`, days left / expired, and asks the user to confirm. `ambiguous` results show both readings as buttons. `noExpiry` shows "Never expires". No result offers manual entry, parsed with `findDatesInText` and previewed before saving. `confirmDate` / `confirmLifetime` is where a confirmed date should be persisted.
- Dev builds show a debug line with `strategy`, `confidence`, `dateOrder` / `dateOrderSource` and `sourceLine`.
- Styles use `StyleSheet` for now (NativeWind is not installed).

### `src/expirationExtractor.ts` — pure logic (no RN deps)
The whole OCR→expiration pipeline is here, fully unit-tested and isomorphic. Input: `MlKitBlock[]` from ML Kit, plus optional `{ now, dateOrder }`. Output: `ExpirationExtraction`.

**Day-first vs month-first** is detected per document (`detectDateOrder`), not configured: (1) evidence: another numeric date with a part > 12; (2) country words: PAKISTAN/UK/India/... or `LICENCE` → DMY, USA / US state names / `DRIVER LICENSE` / `PERMANENT RESIDENT` → MDY; (3) default DMY with `ambiguous: true` and `alternativeIso`. A date valid in only one order is never ambiguous.

**Pipeline** (early return on first hit):
1. `mrz` — TD1/TD2/TD3 machine-readable zone; birth and expiry check digits must both be correct.
2. `label-same-line` — each date on the line belongs to the label just before it, so `ISS … EXP …` picks the EXP date; dates before any label count only if the line has no issue/birth label. Ranges pick the later date.
3. `lifetime` — the expiry label line says LIFETIME / UNLIMITED / … ("permanent" only right after the label).
4. `label-nearby` — every value line is assigned to its closest label (same row to the right preferred, then below within 5 line units, above penalised). Values owned by an issue/birth label are never used; the closest expiry-owned value wins (may be LIFETIME → `noExpiry`).
5. `fallback-score` — only future dates (≤ 25y) on unlabelled lines, `confidence: 'low'`; month/year only with bank-card context. Receipts/certificates therefore return `none`.

**Geometry** is in line units (median `frame.height`, fallback 30px), so results don't depend on photo resolution.

**Pre-processing on every line**: `markSplitExpiryLabels` (VALID/THRU split within 1.4 units) and `markImpliedCardExpiryLines` (bank-card context: network keyword or 16-digit / Amex number → bare `%01/09` lines are expiry lines).

**Date parsing** (`parseDatesInLine`, applied in order with matched text blanked out): year-first `2030-03-15` → `15 MAR 2030` / `15-Mar-30` / `14NOV2014` / `5th June 2028` / bilingual `MAR /MARS` → `Mar 15, 2030` → numeric D/M/Y or M/D/Y → numeric month/year `12/27` (a dot only with a 4-digit year, so prices aren't dates) → `June 2028`. Month/year dates use the **last day of the month** (`precision: 'month'`). Month names in English, Spanish, Portuguese, French, German. Two-digit years: ≥70 → 1900s, <70 → 2000s.

**OCR normalization** (`normalizeOcrForDateParsing`): Unicode dashes/slashes, merged slashes in either order (`0504/2027`, `2504/2027`, but not year ranges `2012-2016`), `0CT→OCT`, `06/15l2016`, `01112/2022`, `EXP01/06/2024`, `ExpQ7/22/2033`, `01/07203→01/07/2030`.

**Output**: `date`, `iso`, `display` (`05 Mar 2036`, `Dec 2027` or `Lifetime`), `sourceLine`, `strategy`, `confidence`, `noExpiry`, `ambiguous`, `alternativeIso`, `dateOrder`, `dateOrderSource`.

### `__tests__/`
- `expirationExtractor.test.tsx` — US documents, DMY/MDY detection, CNIC layouts, other formats (`test.each` table), MRZ, lifetime, no-expiry documents (receipts, certificates, prices), resolution independence, nearest-label selection, normalization, labels. **All extraction tests pass a fixed `NOW` (13 Oct 2026)** via the `extract()` helper. Helpers: `blocksFromRows([[text, y], ...])` (no heights → 30px unit) and `layout([[text, top, left], ...], scale)` (with heights).
- `App.test.tsx` — render smoke test with the native modules mocked.

### `docs/domain/expiration-date-extraction.md`
Mirror of `README.md` content. Edit both together (or pick one and reference the other). Its examples table is generated from the real extractor output.

## Working Conventions

- The expiration extractor is the only non-trivial TypeScript logic. Prefer editing `src/expirationExtractor.ts` and extending `__tests__/expirationExtractor.test.tsx` in the same change.
- Always pass `now` in extractor tests; never depend on the real clock.
- Don't add a regional date-order setting: keep detection document-driven and surface uncertainty through `ambiguous`.
- Adding a new OCR backend: only do it if it provides per-line `frame` geometry (see `MlKitFrame` / `MlKitLine` in `src/expirationExtractor.ts`). Without geometry, `label-nearby` can't run.
- The `expirationExtractor.ts` file is intentionally self-contained — no React Native imports. Keep it that way so the test suite stays fast and dependency-free.
- Strategy values form a closed enum: `'mrz' | 'label-same-line' | 'lifetime' | 'label-nearby' | 'fallback-score' | 'none'`. UI in `App.tsx` reads `strategy` / `confidence` for debugging.
- Public API surface lives in `src/expirationExtractor.ts`; the docs file lists it for reference.

## Android specifics

`android/build.gradle` pins: `minSdkVersion 24`, `compileSdkVersion 36`, `targetSdkVersion 36`, `buildToolsVersion 36.0.0`, `ndkVersion 27.1.12297006`, `kotlinVersion 2.1.20`. Gradle wrapper is 8.13 (`android/gradle/wrapper/gradle-wrapper.properties`). `android/gradle.properties` enables Hermes + New Architecture and builds for `armeabi-v7a, arm64-v8a, x86, x86_64`.

`applicationId` / `namespace` are still `com.myprojectname` (RN starter default). If you ship under a real package id, update both `android/app/build.gradle` (`namespace` + `applicationId`), Java/Kotlin package directories under `android/app/src/main/java`, and re-run a clean build (`cd android && ./gradlew clean`).

No storage permission is requested: the gallery uses the system photo picker. Don't add `READ_MEDIA_IMAGES` (Google Play restricts it). Camera permission is requested only on demand (see `App.tsx`).
