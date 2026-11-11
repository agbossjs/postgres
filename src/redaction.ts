/**
 * What the package prints of a text that may hold a connection string (agbossjs/agboss#891), the
 * same function with the same tests as `@agboss/mongodb`'s. Each whitespace-separated token with
 * a `scheme://` and an `@` after it has everything from the first `:` after the scheme up to its
 * LAST `@` masked — the password whatever it holds (`@`, `/`, `:`, `#`, `?`, `%40`), never parsed
 * as a URL, which splits such a password elsewhere; a token holding two URLs, or a port, is masked
 * more, never less. Then every `password=`, `sslpassword=` and `pass=` query parameter.
 */
export function withoutPasswords(text: string): string {
  return text.split(/(\s+)/u).map(maskedToken).join("");
}

/** One token, its passwords masked. */
function maskedToken(token: string): string {
  const scheme = token.indexOf("://");
  const at = token.lastIndexOf("@");
  const colon = scheme === -1 ? -1 : token.indexOf(":", scheme + 3);
  const userinfoMasked =
    scheme !== -1 && colon !== -1 && colon < at
      ? `${token.slice(0, colon + 1)}***${token.slice(at)}`
      : token;
  return userinfoMasked.replaceAll(/([?&](?:sslpassword|password|pass)=)[^&#\s]*/giu, "$1***");
}
