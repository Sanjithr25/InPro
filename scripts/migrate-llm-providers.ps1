# LLM Provider Migration Script (PowerShell)
# This script helps migrate your database to support the new LLM provider system

Write-Host "🚀 LLM Provider Migration Script" -ForegroundColor Cyan
Write-Host "=================================" -ForegroundColor Cyan
Write-Host ""

# Check if DATABASE_URL is set
$DATABASE_URL = $env:DATABASE_URL
if (-not $DATABASE_URL) {
    Write-Host "❌ ERROR: DATABASE_URL environment variable is not set" -ForegroundColor Red
    Write-Host "Please set it in your .env file or set it temporarily:" -ForegroundColor Yellow
    Write-Host '  $env:DATABASE_URL = "postgresql://..."' -ForegroundColor Yellow
    exit 1
}

Write-Host "✅ DATABASE_URL found" -ForegroundColor Green
Write-Host ""

# Confirm before proceeding
Write-Host "This script will:" -ForegroundColor Yellow
Write-Host "  1. Update the llm_settings table constraint"
Write-Host "  2. Convert localhost Ollama entries to 'llama-local'"
Write-Host "  3. Ensure a default provider exists"
Write-Host ""

$confirmation = Read-Host "Do you want to proceed? (y/N)"
if ($confirmation -ne 'y' -and $confirmation -ne 'Y') {
    Write-Host "❌ Migration cancelled" -ForegroundColor Red
    exit 0
}

Write-Host ""
Write-Host "📦 Running migration..." -ForegroundColor Cyan
Write-Host ""

# Check if psql is available
$psqlPath = Get-Command psql -ErrorAction SilentlyContinue
if (-not $psqlPath) {
    Write-Host "❌ ERROR: psql command not found" -ForegroundColor Red
    Write-Host "Please install PostgreSQL client tools or use the SQL script manually" -ForegroundColor Yellow
    Write-Host "SQL file location: apps/api/src/db/migrate-llm-providers.sql" -ForegroundColor Yellow
    exit 1
}

# Run the migration SQL
try {
    psql $DATABASE_URL -f apps/api/src/db/migrate-llm-providers.sql
    
    Write-Host ""
    Write-Host "✅ Migration completed successfully!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Next steps:" -ForegroundColor Cyan
    Write-Host "  1. Update your .env file (see .env.example)"
    Write-Host "  2. Rebuild: npm run build"
    Write-Host "  3. Restart: npm run dev"
    Write-Host ""
    Write-Host "📚 For more details, see:" -ForegroundColor Cyan
    Write-Host "  - Docs/Migration_Guide.md"
    Write-Host "  - Docs/LLM_Provider_Refactor.md"
}
catch {
    Write-Host ""
    Write-Host "❌ Migration failed!" -ForegroundColor Red
    Write-Host "Error: $_" -ForegroundColor Red
    Write-Host "Please check the error messages above and try again." -ForegroundColor Yellow
    exit 1
}
