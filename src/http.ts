export function parseNextLink(linkHeader: string | string[] | undefined): string | null {
  if (!linkHeader) return null;
  const headers = Array.isArray(linkHeader) ? linkHeader : [linkHeader];
  for (const header of headers) {
    for (const part of header.split(",")) {
      const match = part.match(/<([^>]+)>;\s*rel="next"/);
      if (match) return match[1];
    }
  }
  return null;
}
