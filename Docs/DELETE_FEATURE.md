# LLM Provider Delete Feature

## Overview

Users can now delete configured LLM providers from both the API and the frontend UI with comprehensive safety checks.

## Backend Implementation

### API Endpoint
```
DELETE /api/llm-settings/:id
```

### Safety Features

1. **404 Protection**: Returns error if provider doesn't exist
2. **Last Provider Protection**: Prevents deletion of the only provider
3. **Default Reassignment**: Automatically sets another provider as default if deleting current default
4. **Agent Migration**: Updates all agents using the deleted provider to use NULL (falls back to default)
5. **Informative Response**: Returns count of affected agents

### Response Example

```json
{
  "data": {
    "deleted": true,
    "agentsUpdated": 3,
    "message": "Provider deleted. 3 agent(s) will now use the default provider."
  }
}
```

### Error Cases

**Trying to delete the only provider:**
```json
{
  "error": "Cannot delete the only LLM provider. Add another provider first or set a different one as default."
}
```

**Provider not found:**
```json
{
  "error": "LLM setting not found"
}
```

## Frontend Implementation

### Location
`apps/web/src/app/settings/page.tsx`

### UI Flow

1. **Initial State**: Delete button appears on each provider card
   - Styled as ghost button with trash icon
   - Located on the right side of the action bar

2. **First Click**: Button changes to confirmation state
   - Text changes to "Confirm Delete?"
   - Styling changes to danger (red background)
   - User has time to reconsider

3. **Blur Event**: If user clicks away, confirmation resets
   - Button returns to normal "Delete" state
   - Prevents accidental deletions

4. **Second Click**: Deletion executes
   - Button shows spinner during deletion
   - API call to DELETE endpoint
   - Success/error message displayed via alert

5. **Success**: Provider card removed
   - List refreshes automatically
   - Message shows affected agents count

### Code Example

```typescript
const handleDelete = async () => {
  if (!confirmDelete) {
    setConfirmDelete(true);
    return;
  }

  setDeleting(true);
  try {
    const result = await llmApi.delete(setting.id);
    alert(result.message);
    onDeleted();
  } catch (err: any) {
    alert(err.message || 'Failed to delete provider');
    setDeleting(false);
    setConfirmDelete(false);
  }
};
```

### Visual States

**Normal State:**
```
[Save] [Set as Default]                    [Delete]
```

**Confirmation State:**
```
[Save] [Set as Default]          [Confirm Delete?]
                                  (red background)
```

**Deleting State:**
```
[Save] [Set as Default]          [🔄 Delete]
                                  (spinner)
```

## API Client

### Location
`apps/web/src/lib/api.ts`

### Method

```typescript
delete: (id: string) =>
  req<{ deleted: boolean; agentsUpdated: number; message: string }>(
    `/api/llm-settings/${id}`, 
    { method: 'DELETE' }
  )
```

## Testing

### Manual Testing Steps

1. **Test Normal Deletion**
   ```bash
   # Add a test provider
   curl -X POST http://localhost:3001/api/llm-settings \
     -H "Content-Type: application/json" \
     -d '{"provider":"groq","api_key":"test","model_name":"test-model"}'
   
   # Delete it
   curl -X DELETE http://localhost:3001/api/llm-settings/{id}
   ```

2. **Test Last Provider Protection**
   ```bash
   # Try to delete when only one provider exists
   curl -X DELETE http://localhost:3001/api/llm-settings/{only-id}
   # Should return error
   ```

3. **Test Default Reassignment**
   ```bash
   # Delete the default provider (when multiple exist)
   # Another provider should automatically become default
   ```

4. **Test Agent Migration**
   ```bash
   # Create agent with specific provider
   # Delete that provider
   # Check agent's llm_provider_id is now NULL
   ```

### Frontend Testing

1. Open Settings page: `http://localhost:3000/settings`
2. Click "Delete" on a provider
3. Verify button changes to "Confirm Delete?" with red styling
4. Click away - verify button resets
5. Click "Delete" again, then "Confirm Delete?"
6. Verify success message and card removal

## Security Considerations

1. **No Cascade Delete**: Agents are updated, not deleted
2. **Atomic Operations**: All updates in single transaction
3. **Validation**: Provider existence checked before deletion
4. **User Confirmation**: Two-click process prevents accidents
5. **Informative Feedback**: User knows impact before confirming

## Future Enhancements

1. **Soft Delete**: Archive instead of hard delete
2. **Undo Feature**: Allow restoration within time window
3. **Bulk Delete**: Delete multiple providers at once
4. **Export Before Delete**: Download provider config before deletion
5. **Better Modal**: Replace alert() with custom modal dialog
