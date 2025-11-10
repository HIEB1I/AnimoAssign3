// tiny classnames helper
export const cls = (...s: Array<string | false | undefined | null>) =>
  s.filter(Boolean).join(" ");
