import { sql } from 'kysely';
import type { Database } from '$server/db';
import { logger } from '$server/logger';

export type MigrationFn = (step: number, query: string | ((db: Database) => Promise<void>)) => void;
export type Migration = (runStep: MigrationFn) => void;

const log = logger('ca:migration');

export async function migrate(migration: Migration, db: Database) {
	const steps: { step: number; query: string | ((db: Database) => Promise<void>) }[] = [];

	function runStep(step: number, query: string | ((db: Database) => Promise<void>)) {
		const expectedStep = (steps[steps.length - 1]?.step ?? 0) + 1;

		if (step !== expectedStep) {
			throw new Error(`Invalid step, expected "${expectedStep}" but got "${step}"`);
		}

		steps.push({ step, query });
	}

	async function getCurrentStep() {
		const dbStep = (await db.selectFrom('__migration__').select('step').executeTakeFirst())?.step;

		if (dbStep === undefined) {
			await db.insertInto('__migration__').values({ step: 0 }).execute();
			return 0;
		}

		if (Number.isNaN(+dbStep)) {
			throw new Error(`The current migration step is invalid`);
		}

		return +dbStep;
	}

	// Run migration file and collect migration steps
	migration(runStep);

	// Ensure migration table exists
	await sql`CREATE TABLE IF NOT EXISTS __migration__ (step INT NOT NULL)`.execute(db);

	// Get current migration step
	const currentStep = await getCurrentStep();

	// Run each migration step independently.
	// This is important for TiDB because DDL statements are not transactional.
	for (const migrationStep of steps) {
		if (migrationStep.step <= currentStep) {
			continue;
		}

		log.info(`Migrating step ${migrationStep.step}...`);

		try {
			if (typeof migrationStep.query === 'function') {
				await migrationStep.query(db);
			} else {
				await sql.raw(migrationStep.query).execute(db);
			}

			await db
				.updateTable('__migration__')
				.set({ step: migrationStep.step })
				.execute();

			log.info(`Finished migrating step ${migrationStep.step}`);
		} catch (err) {
			throw new Error(`Failed to migrate step "${migrationStep.step}": ${err}`);
		}
	}
}
