export const formatAuthor = (email: string, username?: string): string => {
  if (username) return `@${username}`;
  if (email && email.includes('@')) return `@${email.split('@')[0]}`;
  return `@${email?.slice(0, 8) || 'user'}`;
};
