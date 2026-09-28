CREATE TABLE `annotations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`page_index` integer NOT NULL,
	`kind` text NOT NULL,
	`rects` text DEFAULT '[]' NOT NULL,
	`quote` text DEFAULT '' NOT NULL,
	`note_id` integer,
	`message_id` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `annotations_book_page_idx` ON `annotations` (`book_id`,`page_index`);--> statement-breakpoint
CREATE TABLE `books` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_id` integer NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`file_path` text NOT NULL,
	`file_hash` text NOT NULL,
	`page_count` integer DEFAULT 0 NOT NULL,
	`page_offset` integer DEFAULT 0 NOT NULL,
	`text_source` text DEFAULT 'native' NOT NULL,
	`outline` text DEFAULT '[]' NOT NULL,
	`manual_chapters` text DEFAULT '[]' NOT NULL,
	`last_page` integer DEFAULT 0 NOT NULL,
	`page_image_mode` integer DEFAULT false NOT NULL,
	`ocr_status` text DEFAULT 'none' NOT NULL,
	`ocr_error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `books_hash_idx` ON `books` (`file_hash`);--> statement-breakpoint
CREATE TABLE `concept_evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`concept_id` integer NOT NULL,
	`session_id` integer,
	`kind` text NOT NULL,
	`polarity` integer DEFAULT 0 NOT NULL,
	`detail` text NOT NULL,
	`page_index` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`concept_id`) REFERENCES `concepts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `concepts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_id` integer NOT NULL,
	`name` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'introduced' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`last_updated` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `concepts_subject_name_idx` ON `concepts` (`subject_id`,`name`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`kind` text NOT NULL,
	`page_index` integer,
	`dwell_ms` integer,
	`payload` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `events_session_idx` ON `events` (`session_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer NOT NULL,
	`role` text NOT NULL,
	`action` text DEFAULT 'ask' NOT NULL,
	`content` text NOT NULL,
	`page_index` integer,
	`selection` text,
	`model` text,
	`in_tokens_est` integer,
	`out_tokens_est` integer,
	`status` text DEFAULT 'ok' NOT NULL,
	`question_id` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_session_idx` ON `messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_id` integer NOT NULL,
	`book_id` integer,
	`session_id` integer,
	`page_from` integer,
	`page_to` integer,
	`concept_ids` text DEFAULT '[]' NOT NULL,
	`title` text NOT NULL,
	`body_md` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'user' NOT NULL,
	`compression` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `pages` (
	`book_id` integer NOT NULL,
	`page_index` integer NOT NULL,
	`text` text DEFAULT '' NOT NULL,
	`text_source` text DEFAULT 'native' NOT NULL,
	`char_count` integer DEFAULT 0 NOT NULL,
	`section_label` text,
	`needs_ocr` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`book_id`, `page_index`),
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `practice_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_id` integer NOT NULL,
	`book_id` integer,
	`session_id` integer,
	`page_from` integer,
	`page_to` integer,
	`concept_ids` text DEFAULT '[]' NOT NULL,
	`type` text NOT NULL,
	`prompt` text NOT NULL,
	`answer` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'tutor' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_id` integer NOT NULL,
	`book_id` integer,
	`session_id` integer,
	`page_index` integer,
	`selection` text,
	`text` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`answer_note_id` integer,
	`source` text DEFAULT 'app' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`item_id` integer NOT NULL,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`grade` text NOT NULL,
	`interval_days` real NOT NULL,
	`ease` real NOT NULL,
	`due_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `practice_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`book_id` integer NOT NULL,
	`subject_id` integer NOT NULL,
	`type` text NOT NULL,
	`goal` text,
	`timebox_min` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`ended_at` integer,
	`last_activity_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`start_page` integer,
	`end_page` integer,
	`opening` text,
	`rolling_summary` text DEFAULT '' NOT NULL,
	`summarized_through_id` integer DEFAULT 0 NOT NULL,
	`debrief` text,
	`debrief_accepted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_status_idx` ON `sessions` (`status`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `subjects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`tutor_profile_id` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`tutor_profile_id`) REFERENCES `tutor_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subjects_slug_unique` ON `subjects` (`slug`);--> statement-breakpoint
CREATE TABLE `tutor_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`persona` text DEFAULT '' NOT NULL,
	`style` text NOT NULL,
	`answer_policy` text NOT NULL,
	`verbosity` text DEFAULT 'normal' NOT NULL,
	`notation` text DEFAULT '' NOT NULL,
	`rules` text DEFAULT '[]' NOT NULL,
	`model_overrides` text DEFAULT '{}' NOT NULL,
	`session_type_overrides` text DEFAULT '{}' NOT NULL,
	`preferences` text DEFAULT '[]' NOT NULL,
	`preset_slug` text
);
--> statement-breakpoint
CREATE TABLE `usage_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`session_id` integer,
	`role` text NOT NULL,
	`purpose` text DEFAULT '' NOT NULL,
	`model` text NOT NULL,
	`provider` text NOT NULL,
	`in_tokens_est` integer DEFAULT 0 NOT NULL,
	`out_tokens_est` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`ok` integer DEFAULT true NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `usage_ts_idx` ON `usage_log` (`ts`);--> statement-breakpoint
CREATE TABLE `weekly_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`subject_id` integer NOT NULL,
	`week_start` text NOT NULL,
	`metric` text NOT NULL,
	`target` integer NOT NULL,
	FOREIGN KEY (`subject_id`) REFERENCES `subjects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weekly_targets_unique` ON `weekly_targets` (`subject_id`,`week_start`,`metric`);