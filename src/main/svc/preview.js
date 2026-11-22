// File preview service (typed previews for the Files tab / artifact viewer). Logic lives in ../files-preview.js.
import { createPreview } from '../files-preview.js';

export function create({ getProject }) {
  return createPreview({ getProject });
}
