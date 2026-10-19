/** Explicitly excluded by the owner: no account configuration, membership management or global ordering. */
export const excludedActions:ReadonlySet<string>=new Set([
 'books.setBaseCurrency','books.quit','books.members','books.reorder',
 'assets.reorder','assets.groups.reorder','tags.reorderGroups','savings.reorder',
]);
export const isPublicAction=(action:string)=>!excludedActions.has(action);
