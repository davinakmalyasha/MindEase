-- Records whether a clinical briefing was written by the model or assembled
-- locally as a deterministic fallback.
--
-- The briefing is read asynchronously and can be re-read long after it was
-- generated, so a provenance flag carried only on the HTTP response would be
-- gone by the time a clinician opened the cached copy. The origin has to live
-- next to the text.
--
-- Defaults to 'model': every row that exists before this migration was produced
-- by a live Gemini call, so a NULL/default reading of 'model' is the truthful
-- one for the existing data rather than a guess.
ALTER TABLE `PreSessionData` ADD COLUMN `briefingSource` VARCHAR(191) NOT NULL DEFAULT 'model';

-- Constrain the domain in the database as well as in the TypeScript union, so a
-- typo or a hand-edited row cannot introduce a third value the UI has no
-- rendering for.
ALTER TABLE `PreSessionData`
  ADD CONSTRAINT `PreSessionData_briefingSource_check`
  CHECK (`briefingSource` IN ('model', 'fallback'));
