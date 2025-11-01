# 🔍 Debatable

**A Chrome Extension for Real-Time Statement Verification**

> Leverage on-device AI to identify questionable claims, debated facts, and hyperbole as you browse the web — all without sending your data to the cloud.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 🎯 The Problem

In an era of misinformation, readers need tools to critically evaluate online content. Traditional fact-checking is slow, manual, and doesn't scale to the billions of statements published daily across the web.

## 💡 Our Solution

**Debatable** uses Chrome's built-in Gemini Nano AI model to analyze web content in real-time, highlighting potentially problematic statements directly on the page. Everything runs locally on your device — no API calls, no data collection, complete privacy.

## Features

### ✨ What It Does

- **🎯 Intelligent Sentence Extraction**: Automatically identifies and extracts declarative statements from web pages
- **🤖 On-Device AI Classification**: Uses Chrome's Gemini Nano model to classify statements into four categories:
  - 🔴 **False**: Statements that contradict well-established facts
  - 🟡 **Debated**: Claims with credible expert disagreement presented as fact
  - 🟠 **Hyperbole**: Rhetorical or promotional exaggeration
  - ⚪ **Neutral**: No issues detected
- **💫 Real-Time Highlighting**: Sentences are highlighted inline with color-coded visual indicators
- **📊 Interactive Panel**: Side panel showing all flagged statements with detailed breakdowns
- **🎨 Customizable Categories**: Configure your own classification categories, colors, and definitions
- **⚡ Smart Caching**: 24-hour cache with intelligent invalidation to minimize processing
- **📈 Progress Tracking**: Live progress indicators with ETA estimates for batch processing
- **🔒 Privacy-First**: All processing happens locally — your browsing data never leaves your device

### 🎨 User Experience

- **Glassmorphism UI**: Modern, translucent legend that blends seamlessly with any webpage
- **Responsive Tooltips**: Hover over highlights to see classification details and confidence scores
- **Keyboard Shortcuts**: Navigate flagged statements quickly
- **Debug Mode**: Developer-friendly logging for prompt engineering and model fine-tuning

### 🚀 Planned Features

- **Full Gemini Nano Integration**: Replace mock classification with real AI-powered fact-checking
- **User Override System**: Allow users to accept/reject classifications with learning
- **Dynamic Content Support**: Monitor page changes and classify new content automatically
- **Multi-Language Support**: Privacy-preserving translation pipeline
- **Browser Extension Sync**: Sync user preferences and overrides across devices
- **Confidence Scores**: Display AI confidence levels for each classification

## 🏗️ Architecture

### Project Structure

```
debatable/
├── manifest.json              # Chrome Extension manifest (MV3)
├── src/
│   ├── background.js          # Service worker: API broker, caching, message routing
│   ├── contentScript.js       # DOM extraction, highlighting, UI injection
│   ├── styles/
│   │   └── highlights.css     # Visual styling for highlights and legend
│   ├── ui/
│   │   ├── panel.html/js      # Side panel for detailed classification view
│   │   ├── popup.html/js      # Extension popup controls
│   │   └── options.html/js    # Settings page for model configuration
│   ├── classifier/            # (Reserved for future AI model integration)
│   └── util/                  # Shared utilities
└── tests/
    └── extraction.spec.txt    # Test cases for sentence extraction
```

### Technical Stack

- **Frontend**: Vanilla JavaScript, HTML5, CSS3 (no frameworks = faster load times)
- **AI Model**: Chrome Built-in AI (Gemini Nano via Prompt API)
- **Storage**: Chrome Storage API with in-memory LRU cache
- **Architecture**: Event-driven message passing between content script and service worker

## 🚀 Getting Started

### Prerequisites

- **Chrome Canary or Dev Channel** (version 128+)
- **Enable Chrome Flags** at `chrome://flags`:
  - `#optimization-guide-on-device-model` → **Enabled BypassPerfRequirement**
  - `#prompt-api-for-gemini-nano` → **Enabled**

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/debatable.git
cd debatable

# Load the extension
# 1. Open Chrome and navigate to chrome://extensions
# 2. Enable "Developer Mode" (toggle in top right)
# 3. Click "Load unpacked"
# 4. Select the project root directory
```

### Quick Start

1. **Navigate to any article or blog post** (try news sites, Wikipedia, Medium)
2. **Wait for the legend to appear** in the bottom-right corner
3. **Click "Panel"** in the legend to open the side panel with all flagged statements
4. **Hover over highlighted text** to see classification details
5. **Configure categories** via Options (right-click extension icon → Options)

### Running Tests

```bash
# View test cases
cat tests/extraction.spec.txt

# Manual testing checklist:
# 1. Load extension on various websites (news, blogs, social media)
# 2. Verify highlights appear correctly
# 3. Check side panel shows all classifications
# 4. Test with dynamic content (infinite scroll, SPAs)
# 5. Verify cache behavior (reload page, should be instant)
```

## 🔧 Configuration

### Model Setup (Gemini Nano)

The extension leverages Chrome's built-in Gemini Nano model for on-device inference:

1. **Ensure prerequisites are met** (Chrome Canary/Dev 128+ with flags enabled)
2. **Open extension options** (right-click extension icon → Options)
3. **Enable "Prompt API"** checkbox
4. **Model download**: Gemini Nano (~1.5GB) downloads automatically on first classification
   - Requires user interaction (gesture) to trigger download
   - Progress shown in browser's download UI
   - One-time setup, persists across browser sessions

### Custom Categories

Create your own classification categories via Options page:

- **Category ID**: Unique identifier (e.g., `satire`, `speculation`)
- **Label**: Display name shown in UI
- **Definition**: Prompt instruction for AI model
- **Colors**: Background and text color (hex codes)

Example custom category:
```json
{
  "id": "satire",
  "label": "Satire",
  "definition": "Humorous exaggeration or irony intended to mock or criticize",
  "color": "#a855f7",
  "textColor": "#ffffff"
}
```

## ⚠️ Current Limitations

- **Sentence Coverage**: Processes first 60 sentences by default (configurable in options, but more = slower)
- **Mock Classification**: Currently uses regex pattern matching; full AI integration pending
- **Static Content Only**: Dynamic/infinite scroll content requires page reload
- **Performance**: May cause lag on extremely large pages (10,000+ sentences)
- **English Only**: Multi-language support coming soon
- **No Mobile Support**: Chrome for Android doesn't yet support Gemini Nano

## 🎓 Technical Challenges & Solutions

### Challenge 1: Accurate Sentence Extraction
**Problem**: HTML structure makes it difficult to extract grammatically complete sentences.

**Solution**: Implemented a custom walker that traverses text nodes while preserving document structure, using regex to split on sentence boundaries while handling edge cases (abbreviations, quotes, lists).

### Challenge 2: Performance at Scale
**Problem**: Classifying hundreds of sentences would block the UI thread.

**Solution**: Batch processing with incremental rendering. Sentences are classified in batches of 20, with highlights applied progressively. Service worker handles heavy lifting off the main thread.

### Challenge 3: Privacy & Data Security
**Problem**: Users shouldn't have to trust a third-party API with their browsing content.

**Solution**: Chrome's Built-in AI (Gemini Nano) runs entirely on-device. Zero network requests, zero data collection, zero trust required.

## 💡 Pro Tips

- **Best Results**: Use on long-form content (articles, essays, research papers)
- **Performance**: Enable cache in options for instant re-classification on page revisits
- **Debugging**: Enable debug logging in options to see AI prompts and responses
- **Custom Categories**: Define domain-specific categories (e.g., "medical-claim", "legal-statement")
- **Keyboard Navigation**: Tab through highlights, Enter to jump to next flagged statement


## 📊 Demo & Screenshots

### Example Use Case: News Article

![Debatable in action](https://via.placeholder.com/800x450?text=Screenshot+Coming+Soon)

### Side Panel View

![Side panel showing flagged statements](https://via.placeholder.com/400x600?text=Panel+Screenshot)

### Custom Categories Configuration

![Options page with custom categories](https://via.placeholder.com/800x500?text=Options+Screenshot)

## 🤝 Contributing

We welcome contributions! This is an open-source project built for the community.

### Development Setup

```bash
# Clone and install
git clone https://github.com/yourusername/debatable.git
cd debatable

# Make your changes
# Test locally by loading unpacked extension

# Submit PR with description of changes
```

**Key Innovation**: Leveraging Chrome's built-in AI (Gemini Nano) for completely private, on-device inference—no API keys, no cloud services, no data collection.

## 📚 Resources & References

- [Chrome Built-in AI Documentation](https://developer.chrome.com/docs/ai/built-in)
- [Gemini Nano Prompt API Guide](https://developer.chrome.com/docs/ai/built-in-apis)
- [Chrome Extension Manifest V3](https://developer.chrome.com/docs/extensions/mv3/)
- [Web Content Accessibility Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)

## 📄 License

This project is licensed under the MIT License. Feel free to use, modify, and distribute it as per the license terms.

## 🙏 Acknowledgments

- Chrome team for making Built-in AI available to developers
- Open-source community for inspiration and support
- Hackathon organizers and mentors

---

**Made with ❤️ for a more informed internet**
