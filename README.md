# Debatable (Chrome Extension)

Highlight potentially false, debated, or hyperbolic statements directly on any webpage using on-device AI.

## Status

This project is currently in the MVP (Minimum Viable Product) stage. It uses Chrome's built-in AI model for local classification and provides a foundation for further development.

## Features

### Current Features

- **Sentence Extraction**: Extracts up to the first 60 sentences from a webpage using a basic heuristic.
- **Batch Classification**: Processes sentences in batches using a background service worker.
- **Mock Classification**: Uses regex patterns to classify sentences into categories:
  - **False**: Highlighted in red.
  - **Debated**: Highlighted in yellow.
  - **Hyperbole**: Highlighted in orange.
- **Inline Highlighting**: Highlights sentences directly on the webpage with a legend panel and a side panel for flagged statements.
- **Caching**: Implements a cache framework for future API integration.
- **Live Progress Tracker**: Displays incremental highlighting progress, ETA estimates, and responsive status toasts.
- **Modern UI**: Includes a refreshed popup, glassmorphism legend, and a configurable category manager with custom colors and definitions.

### Planned Features

- Integration with the Gemini Nano model for real on-device factual assessment.
- User overrides and persistence for classifications.
- Support for dynamically loaded content using a mutation observer.
- Privacy mode and translator pipeline for enhanced user control.

## File Structure

- `manifest.json`: Defines the Chrome extension (Manifest V3).
- `src/background.js`: Service worker and classification broker.
- `src/contentScript.js`: Handles sentence extraction and highlight injection.
- `src/styles/highlights.css`: Contains styling for highlights.
- `src/ui/panel.html|js`: Implements the side panel UI.
- `src/ui/popup.html|js`: Manages popup controls.
- `src/ui/options.html|js`: Provides an options page for configuring the model and categories.

## Getting Started

### Prerequisites

- **Browser**: Chrome Canary or Dev channel (version 128+).
- **Flags**: Enable the following flags in `chrome://flags`:
  - `#optimization-guide-on-device-model` → Enabled BypassPerfRequirement.
  - `#prompt-api-for-gemini-nano` → Enabled.

### Installation

1. Clone this repository to your local machine.
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable Developer Mode.
4. Click "Load unpacked" and select the project root directory.

### Usage

1. Navigate to a content-rich webpage.
2. Observe the highlights and the legend panel.
3. Click on the legend to open the side panel for detailed classifications.

### Testing

1. Open the `tests/extraction.spec.txt` file for test cases.
2. Manually verify sentence extraction and classification on various webpages.
3. Use the browser console to debug and inspect logs.

## On-Device Model Setup

The extension uses the Gemini Nano model running locally in your browser:

1. Ensure you're using Chrome Canary or Dev channel (version 128+).
2. Enable the required flags in `chrome://flags` (see Prerequisites).
3. Restart Chrome.
4. Open the extension options and ensure "Enable Prompt API" is checked.
5. The model will download automatically on first use (requires user interaction).

## Category Legend

- **Red**: Likely false.
- **Yellow**: Debated or contentious.
- **Orange**: Hyperbole.

## Limitations

- **Sentence Coverage**: Only processes the first 60 sentences on a page. Option to process more sentences exists, but takes longer. 
- **Dynamic Content**: Does not handle dynamically loaded content (planned feature).
- **Accuracy**: Uses mock classification; real model integration is pending.
- **Performance**: May slow down on extremely large pages.

## Next Steps

- Integrate the Gemini Nano model for real-time factual assessment.
- Implement user overrides and persistence for classifications.
- Add support for dynamically loaded content.
- Enhance the UI with more customization options.
- Optimize performance for large webpages.

## Pro Tips

- Use the extension on content-rich pages for the best results.
- Enable debug logging in the options page to troubleshoot issues.
- Regularly clear the cache to ensure up-to-date classifications.

## License

This project is licensed under the MIT License. Feel free to use, modify, and distribute it as per the license terms.
