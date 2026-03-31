#!/usr/bin/env node

/**
 * Migration Script: Linear Workflows → DAG Workflows
 * ─────────────────────────────────────────────────────────────────────────────
 * Converts existing linear task workflows to the new DAG format.
 * 
 * OLD FORMAT:
 * [
 *   { agentId, stepName, inputTemplate }
 * ]
 * 
 * NEW FORMAT:
 * [
 *   { id, agentId, stepName, inputTemplate, dependsOn: [] }
 * ]
 * 
 * CHANGES:
 * 1. Adds unique "id" field to each step (step1, step2, etc.)
 * 2. Adds "dependsOn" array (linear chain: step2 depends on step1, etc.)
 * 3. Replaces {{prev}} placeholders with {{stepN}} references
 * 
 * USAGE:
 *   node scripts/migrate-task-workflows.js
 */

const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function migrate() {
  console.log('[Migration] Starting task workflow migration to DAG format...\n');

  try {
    // Fetch all tasks
    const { rows: tasks } = await pool.query('SELECT id, name, workflow_definition FROM tasks');
    
    if (tasks.length === 0) {
      console.log('[Migration] No tasks found. Nothing to migrate.');
      return;
    }

    console.log(`[Migration] Found ${tasks.length} task(s) to check.\n`);

    let migratedCount = 0;
    let skippedCount = 0;

    for (const task of tasks) {
      const workflow = Array.isArray(task.workflow_definition) 
        ? task.workflow_definition 
        : JSON.parse(task.workflow_definition || '[]');

      // Check if already migrated (has 'id' and 'dependsOn' fields)
      const needsMigration = workflow.some(step => !step.id || !Array.isArray(step.dependsOn));

      if (!needsMigration) {
        console.log(`✓ Task "${task.name}" already in DAG format. Skipping.`);
        skippedCount++;
        continue;
      }

      console.log(`→ Migrating task "${task.name}"...`);

      // Convert to DAG format
      const migratedWorkflow = workflow.map((step, index) => {
        const stepId = `step${index + 1}`;
        const dependsOn = index === 0 ? [] : [`step${index}`];

        // Replace {{prev}} with {{stepN}} where N is the previous step
        let inputTemplate = step.inputTemplate || '';
        if (index > 0) {
          const prevStepId = `step${index}`;
          inputTemplate = inputTemplate.replace(/\{\{prev\}\}/g, `{{${prevStepId}}}`);
        }

        return {
          id: stepId,
          agentId: step.agentId,
          stepName: step.stepName,
          inputTemplate,
          dependsOn,
        };
      });

      // Update database
      await pool.query(
        'UPDATE tasks SET workflow_definition = $1, updated_at = NOW() WHERE id = $2',
        [JSON.stringify(migratedWorkflow), task.id]
      );

      console.log(`  ✓ Migrated ${workflow.length} step(s)`);
      console.log(`    - Added step IDs: ${migratedWorkflow.map(s => s.id).join(', ')}`);
      console.log(`    - Created linear dependency chain\n`);

      migratedCount++;
    }

    console.log('─────────────────────────────────────────────────────────────');
    console.log(`[Migration] Complete!`);
    console.log(`  - Migrated: ${migratedCount} task(s)`);
    console.log(`  - Skipped:  ${skippedCount} task(s) (already in DAG format)`);
    console.log('─────────────────────────────────────────────────────────────\n');

  } catch (error) {
    console.error('[Migration] Error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
