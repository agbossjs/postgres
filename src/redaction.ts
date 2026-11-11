/**
 * What the package prints of a text that may hold a connection string (agbossjs/agboss#891): every
 * `scheme://user:password@` with its password masked — up to the last `@` before the host's first
 * `/`, so a password holding `@` or `:` is masked whole — and every `password=` / `sslpassword=`
 * query parameter. The same function, with the same tests, as `@agboss/mongodb`'s.
 */
export function withoutPasswords(text: string): string {
  return text
    .replaceAll(/([a-z][a-z0-9+.-]*:\/\/[^/\s:@]*):[^/\s]*@/giu, "$1:***@")
    .replaceAll(/([?&](?:ssl)?password=)[^&\s]*/giu, "$1***");
}
