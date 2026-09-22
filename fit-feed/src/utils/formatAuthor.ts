// Renders an author handle. Takes the public handle (username or public
// displayName) - never a private email. A value containing "@" is tolerated
// so legacy callers passing an email still render sensibly.
export const formatAuthor = (handle?: string, username?: string): string => {
  if (username) return `@${username}`;
  if (!handle) return '@user';
  const local = handle.includes('@') ? handle.split('@')[0] : handle;
  return `@${local || 'user'}`;
};
