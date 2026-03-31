# DAG-Based Workflow System

## Overview

The Tasks system now supports **DAG (Directed Acyclic Graph)** based workflows, enabling:
- **Linear workflows**: Sequential step execution
- **Multi-dependency workflows**: Steps that depend on multiple previous steps
- **Parallel execution**: Steps with the same dependencies run concurrently (up to MAX_PARALLEL=3)

## Workflow Format

Each workflow is defined as an array of steps with the following structure:

```json
[
  {
    "id": "step1",
    "agentId": "uuid-of-agent",
    "stepName": "Research Requirements",
    "inputTemplate": "Research and analyze: {{input}}",
    "dependsOn": []
  },
  {
    "id": "step2",
    "agentId": "uuid-of-agent",
    "stepName": "Design Solution",
    "inputTemplate": "Based on {{step1}}, design a solution",
    "dependsOn": ["step1"]
  }
]
```

### Field Definitions

- **id** (required): Unique step identifier (e.g., "step1", "step2")
- **agentId** (required): UUID of the agent to execute this step
- **stepName** (required): Human-readable step name
- **inputTemplate** (required): Fully executable prompt with placeholders
- **dependsOn** (required): Array of step IDs this step depends on (empty array = root step)

### Placeholder System

Input templates support two types of placeholders:

1. **{{input}}**: The initial task input/prompt
2. **{{stepId}}**: Output from a specific step (e.g., {{step1}}, {{step2}})

Example:
```
"Combine market analysis from {{step1}} with competitor data from {{step2}} to create a report about {{input}}"
```

## Execution Rules

### DAG Validation

Before execution, the system validates:
1. All step IDs are unique
2. All step IDs exist
3. No self-dependencies (step cannot depend on itself)
4. No circular dependencies
5. All dependency references point to existing steps
6. All required fields are present

### Execution Flow

1. **Build DAG**: Parse workflow and identify root/terminal nodes
2. **Find Runnable Steps**: Steps where all dependencies are satisfied
3. **Parallel Execution**: Execute up to MAX_PARALLEL (3) steps concurrently
4. **Store Outputs**: Save each step's output for dependent steps
5. **Repeat**: Continue until all steps complete or failure occurs
6. **Final Output**: Collect outputs from terminal nodes (steps not depended on by others)

### Parallel Execution

Steps with the same dependencies can run in parallel:

```json
[
  {
    "id": "step1",
    "stepName": "Research Market",
    "dependsOn": []
  },
  {
    "id": "step2",
    "stepName": "Research Competitors",
    "dependsOn": []
  },
  {
    "id": "step3",
    "stepName": "Synthesize Report",
    "dependsOn": ["step1", "step2"]
  }
]
```

In this example:
- `step1` and `step2` run in parallel (both are root steps)
- `step3` waits for both to complete, then executes

## Workflow Patterns

### 1. Linear Workflow

```json
[
  { "id": "step1", "dependsOn": [] },
  { "id": "step2", "dependsOn": ["step1"] },
  { "id": "step3", "dependsOn": ["step2"] }
]
```

### 2. Parallel + Merge

```json
[
  { "id": "step1", "dependsOn": [] },
  { "id": "step2", "dependsOn": [] },
  { "id": "step3", "dependsOn": ["step1", "step2"] }
]
```

### 3. Diamond Pattern

```json
[
  { "id": "step1", "dependsOn": [] },
  { "id": "step2", "dependsOn": ["step1"] },
  { "id": "step3", "dependsOn": ["step1"] },
  { "id": "step4", "dependsOn": ["step2", "step3"] }
]
```

### 4. Multiple Terminal Nodes

```json
[
  { "id": "step1", "dependsOn": [] },
  { "id": "step2", "dependsOn": ["step1"] },
  { "id": "step3", "dependsOn": ["step1"] }
]
```

Both `step2` and `step3` are terminal nodes; their outputs are included in `finalOutput`.

## Frontend Features

### Step Editor

- Add/edit/delete steps
- Configure step ID, name, agent, and input template
- Visual dependency selector (multi-select buttons)
- Placeholder help text

### DAG Visualization

The UI displays:
- **Root Steps**: Steps with no dependencies (highlighted in blue)
- **Terminal Steps**: Final output steps (highlighted in green)
- **Dependency Graph**: Visual representation of step dependencies

### Validation

The UI prevents:
- Self-dependencies
- Circular dependencies
- Invalid step ID references

Real-time validation shows errors before saving.

### AI Workflow Generator

The LLM can generate DAG workflows automatically:
1. Select agents to include
2. Provide task description
3. LLM generates steps with appropriate dependencies
4. Review and edit generated workflow

## Backend Implementation

### TaskNode Execution

```typescript
class TaskNode {
  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    // 1. Load and validate workflow
    // 2. Build DAG (identify root/terminal nodes)
    // 3. Execute steps when dependencies satisfied
    // 4. Collect final outputs from terminal nodes
    // 5. Return result with all step outputs
  }
}
```

### Key Features

- **Deterministic**: No runtime interpretation, exact execution
- **Parallel**: Up to 3 steps execute concurrently
- **Observable**: All intermediate outputs logged
- **Fault-tolerant**: Stops on first failure, reports which step failed

### Output Format

```json
{
  "success": true,
  "output": {
    "steps": [
      {
        "stepId": "step1",
        "stepName": "Research",
        "agentId": "uuid",
        "output": "Research results...",
        "runId": "uuid"
      }
    ],
    "finalOutput": {
      "step3": "Final report output..."
    }
  },
  "tokenUsage": { "inputTokens": 1000, "outputTokens": 2000 },
  "toolsUsed": ["web_search", "calculator"]
}
```

## Migration

### Migrating Existing Tasks

Run the migration script to convert linear workflows to DAG format:

```bash
node scripts/migrate-task-workflows.js
```

This script:
1. Adds unique `id` field to each step
2. Adds `dependsOn` array (linear chain)
3. Replaces `{{prev}}` with `{{stepN}}` references
4. Skips tasks already in DAG format

### Manual Migration

OLD FORMAT:
```json
{
  "agentId": "uuid",
  "stepName": "Step 1",
  "inputTemplate": "Do something with {{prev}}"
}
```

NEW FORMAT:
```json
{
  "id": "step1",
  "agentId": "uuid",
  "stepName": "Step 1",
  "inputTemplate": "Do something with {{step0}}",
  "dependsOn": ["step0"]
}
```

## API Endpoints

### Generate Workflow

```http
POST /api/tasks/generate-workflow
Content-Type: application/json

{
  "description": "Research and analyze market trends",
  "agentIds": ["uuid1", "uuid2"],
  "llmProviderId": "uuid" // optional
}
```

Response:
```json
{
  "data": {
    "steps": [
      {
        "id": "step1",
        "agentId": "uuid1",
        "stepName": "Research Market",
        "inputTemplate": "Research market trends for: {{input}}",
        "dependsOn": []
      }
    ]
  }
}
```

### Run Task

```http
POST /api/tasks/:id/run
Content-Type: application/json

{
  "prompt": "AI in healthcare"
}
```

### Dry Run

```http
POST /api/tasks/:id/dry-run
Content-Type: application/json

{
  "prompt": "Test input"
}
```

Dry runs execute the workflow without saving to execution history.

## Best Practices

### 1. Step IDs

- Use descriptive IDs: `research_market`, `analyze_data`, `generate_report`
- Keep IDs short and alphanumeric
- Avoid special characters except underscores

### 2. Dependencies

- Minimize dependencies for maximum parallelism
- Group independent steps to run concurrently
- Use multi-dependency steps to merge parallel branches

### 3. Input Templates

- Be specific and actionable
- Include context from dependencies
- Use {{input}} for user-provided context
- Reference specific steps with {{stepId}}

### 4. Error Handling

- Workflows stop on first failure
- Failed step is reported in output
- All completed steps are logged
- Review logs to identify failure point

### 5. Performance

- Parallel execution limited to MAX_PARALLEL=3
- Long-running steps block dependent steps
- Balance workflow depth vs. parallelism
- Consider breaking large tasks into smaller workflows

## Constraints

- **No runtime interpretation**: Workflows execute exactly as defined
- **No implicit chaining**: Dependencies must be explicit
- **No description-based execution**: Input templates must be executable
- **Deterministic behavior**: Same input always produces same execution path
- **No circular dependencies**: DAG structure enforced

## Future Enhancements

Potential improvements:
- Visual DAG editor with drag-and-drop
- Conditional execution (if/else branches)
- Loop support (iterate over lists)
- Dynamic parallelism (adjust MAX_PARALLEL)
- Step retry logic
- Partial workflow execution
- Workflow templates library
