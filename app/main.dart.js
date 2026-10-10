import 'dart:convert';
import 'dart:math';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:http/http.dart' as http;
import 'package:syncfusion_flutter_pdf/pdf.dart';

// Web version: PDF questions and Smart mode in the browser.
// No login, no saved files, no camera (those stay in the phone app).

void main() => runApp(const DocuChatApp());

const kPrimary = Color(0xFF4F46E5);
const kAccent = Color(0xFF9333EA);
const kMuted = Color(0xFF7A7A85);

class DocuChatApp extends StatelessWidget {
  const DocuChatApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'DocuChat',
      debugShowCheckedModeBanner: false,
      themeMode: ThemeMode.system,
      theme: ThemeData(
        colorSchemeSeed: kPrimary,
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFFF5F5FF),
      ),
      darkTheme: ThemeData(
        colorSchemeSeed: kPrimary,
        brightness: Brightness.dark,
        useMaterial3: true,
        scaffoldBackgroundColor: const Color(0xFF12121A),
      ),
      home: const SplashScreen(),
    );
  }
}

bool isDark(BuildContext c) => Theme.of(c).brightness == Brightness.dark;

Color cardBg(BuildContext c) =>
    isDark(c) ? const Color(0xFF1E1E2C) : Colors.white;

Color fieldBg(BuildContext c) =>
    isDark(c) ? const Color(0xFF2A2A3A) : const Color(0xFFF1F1FB);

// ---------- PDF reading and answering (free, on the phone) ----------

List<String> extractPdfText(Uint8List bytes) {
  final doc = PdfDocument(inputBytes: bytes);
  final extractor = PdfTextExtractor(doc);
  final pages = <String>[];
  for (var i = 0; i < doc.pages.count; i++) {
    pages.add(extractor.extractText(startPageIndex: i, endPageIndex: i));
  }
  doc.dispose();
  return pages;
}

// Smart mode: asks the free Gemini API about the document text.
// Change kModel if Google renames the model.
const kModel = 'gemini-3.6-flash';

// Optional: put YOUR NEW key between the quotes to skip the paste box.
// Keep this file private. Never share the code or the app with a key in it.
const kDefaultKey = '';

Future<String> askAi({
  required String apiKey,
  required List<String> pages,
  required String question,
}) async {
  final doc = StringBuffer();
  for (var i = 0; i < pages.length; i++) {
    doc.writeln('--- Page ${i + 1} ---');
    doc.writeln(pages[i]);
  }
  var text = doc.toString();
  if (text.length > 60000) text = text.substring(0, 60000);

  final body = jsonEncode({
      'systemInstruction': {
        'parts': [
          {
            'text':
                'You answer questions about the document the user provides, '
                'like a careful person who has read it. Use only the '
                'document. Be short and exact. If the answer is not in the '
                'document, say so. For marks, credits or other numbers, '
                'calculate carefully and show the working briefly. The text '
                'may come from a photo (OCR) and contain reading mistakes, '
                'so say when a value looks unclear.',
          },
        ],
      },
      'contents': [
        {
          'role': 'user',
          'parts': [
            {'text': 'DOCUMENT:\n$text\n\nQUESTION: $question'},
          ],
        },
      ],
      'generationConfig': {'temperature': 0.2, 'maxOutputTokens': 4096},
  });

  // Google sometimes says "busy" (503) or "too many requests" (429).
  // Wait a little and try again, up to 3 times in total.
  http.Response? res;
  for (var attempt = 1; attempt <= 3; attempt++) {
    res = await http
        .post(
          Uri.parse(
            'https://generativelanguage.googleapis.com/v1beta/models/$kModel:generateContent',
          ),
          headers: {'x-goog-api-key': apiKey, 'content-type': 'application/json'},
          body: body,
        )
        .timeout(const Duration(seconds: 40));
    final busy = res.statusCode == 503 || res.statusCode == 429;
    if (!busy || attempt == 3) break;
    await Future.delayed(Duration(seconds: 2 * attempt));
  }
  final r = res!;
  if (r.statusCode == 400 || r.statusCode == 401 || r.statusCode == 403) {
    var why = '';
    try {
      why = (jsonDecode(r.body)['error']['message'] as String);
    } catch (_) {}
    if (why.length > 160) why = why.substring(0, 160);
    throw 'Google refused the request (${r.statusCode}). $why';
  }
  if (r.statusCode == 404) {
    throw 'Model "$kModel" was not found. Change kModel in the code.';
  }
  if (r.statusCode == 503) {
    throw 'Google is busy right now. Try again in a minute.';
  }
  if (r.statusCode == 429) {
    throw 'Free limit reached. Wait a minute (or until tomorrow) and try again.';
  }
  if (r.statusCode != 200) throw 'Server error ${r.statusCode}.';
  final data = jsonDecode(r.body) as Map<String, dynamic>;
  final cands = data['candidates'] as List?;
  if (cands == null || cands.isEmpty) throw 'No answer came back.';
  final parts =
      ((cands.first as Map)['content'] as Map?)?['parts'] as List? ?? [];
  final out = parts
      .map((p) => (p as Map)['text'])
      .whereType<String>()
      .join('\n')
      .trim();
  if (out.isEmpty) throw 'The answer was empty.';
  return out;
}

class Reply {
  final String text;
  final List<(String, String)> choices;
  const Reply(this.text, [this.choices = const []]);
}

class PdfBrain {
  final List<String> pageTexts;
  final List<String> sentences;
  final List<int> sentencePage;
  final int totalWords;
  final Map<String, int> freq = {};

  int get pageCount => pageTexts.length;

  static const _synonyms = {
    'author': ['prepared', 'name', 'written'],
    'writer': ['prepared', 'author'],
    'wrote': ['prepared', 'author', 'written'],
    'written': ['prepared', 'author', 'wrote'],
    'creator': ['prepared', 'author'],
    'made': ['prepared', 'created'],
    'created': ['prepared', 'made'],
    'cost': ['price', 'fee', 'amount', 'charge'],
    'price': ['cost', 'fee', 'amount', 'charge'],
    'fee': ['price', 'cost', 'amount', 'charge'],
    'charge': ['price', 'cost', 'fee', 'amount'],
    'salary': ['pay', 'wage', 'income', 'compensation'],
    'pay': ['salary', 'wage', 'income', 'compensation'],
    'wage': ['salary', 'pay', 'income', 'compensation'],
    'income': ['salary', 'pay', 'wage', 'compensation'],
    'subject': ['topic', 'title', 'theme'],
    'title': ['topic', 'subject', 'theme'],
    'topic': ['subject', 'title', 'theme'],
    'theme': ['subject', 'title', 'topic'],
    'deadline': ['date', 'due', 'schedule'],
    'date': ['deadline', 'due', 'schedule', 'time'],
    'due': ['deadline', 'date', 'schedule'],
    'address': ['location', 'place', 'site'],
    'location': ['address', 'place', 'site', 'venue'],
    'place': ['address', 'location', 'site'],
    'venue': ['location', 'address', 'place'],
    'goal': ['objective', 'aim', 'purpose', 'target'],
    'aim': ['objective', 'goal', 'purpose', 'target'],
    'purpose': ['objective', 'goal', 'aim', 'target'],
    'objective': ['goal', 'aim', 'purpose', 'target'],
    'target': ['goal', 'aim', 'objective'],
  };

  static final Set<String> _filler =
      ('the a an my of this pdf detail details info information about show '
              'give me tell please want need see i is to get what which there '
              'are on in')
          .split(' ')
          .toSet();

  static final Set<String> _stop =
      ('the and for are was were with that this from have has had not but you '
              'your can will what when where which who how why about into than '
              'then there their they them its also been being does did any all '
              'our out his her she him tell give say pdf')
          .split(' ')
          .toSet();

  PdfBrain(List<String> pages) : this._(pages, _build(pages));

  PdfBrain._(this.pageTexts, (List<String>, List<int>) built)
    : sentences = built.$1,
      sentencePage = built.$2,
      totalWords = RegExp(r'\S+').allMatches(pageTexts.join(' ')).length {
    for (final s in sentences) {
      for (final w in _words(s)) {
        freq[w] = (freq[w] ?? 0) + 1;
      }
    }
  }

  static (List<String>, List<int>) _build(List<String> pages) {
    final sents = <String>[];
    final nums = <int>[];
    for (var p = 0; p < pages.length; p++) {
      for (final s in _split(pages[p])) {
        sents.add(s);
        nums.add(p);
      }
    }
    return (sents, nums);
  }

  static List<String> _words(String s) {
    return RegExp(r'[a-z0-9]+')
        .allMatches(s.toLowerCase())
        .map((m) => m.group(0)!)
        .where((w) => w.length > 2 && !_stop.contains(w))
        .map(
          (w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss'))
              ? w.substring(0, w.length - 1)
              : w,
        )
        .toList();
  }

  static List<String> _split(String text) {
    final lines = text
        .replaceAll('\r', '\n')
        .split('\n')
        .map((s) => s.replaceAll(RegExp(r'\s+'), ' ').trim())
        .where((s) => s.isNotEmpty)
        .toList();

    final label = RegExp(r'^[A-Za-z][A-Za-z ]{1,24}:');
    final chunks = <String>[];
    var buf = '';
    void flush() {
      if (buf.isNotEmpty) chunks.add(buf);
      buf = '';
    }

    for (final l in lines) {
      if (buf.isNotEmpty && !buf.endsWith(':') && label.hasMatch(l)) {
        flush();
      }
      buf = buf.isEmpty ? l : '$buf $l';
      final endsSentence = RegExp(r'[.!?]$').hasMatch(l);
      if (!buf.endsWith(':') && (endsSentence || l.length < 30)) {
        flush();
      }
    }
    flush();

    return chunks
        .expand((c) => c.split(RegExp(r'(?<=[.!?])\s+')))
        .map((s) => s.trim())
        .where((s) => s.length > 8 && !s.endsWith('?'))
        .toList();
  }

  static String _cut(String s) =>
      s.length > 300 ? '${s.substring(0, 300)}...' : s;

  static bool _isHeading(String s) =>
      s.length < 25 &&
      RegExp(r'[A-Za-z]').hasMatch(s) &&
      !RegExp(r'\d').hasMatch(s) &&
      !s.contains(':') &&
      !RegExp(r'[.!?]$').hasMatch(s);

  int get wordCount => totalWords;

  static int _distance(String a, String b) {
    var prev = List<int>.generate(b.length + 1, (i) => i);
    for (var i = 1; i <= a.length; i++) {
      final cur = List<int>.filled(b.length + 1, 0);
      cur[0] = i;
      for (var j = 1; j <= b.length; j++) {
        final cost = a[i - 1] == b[j - 1] ? 0 : 1;
        cur[j] = min(min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[b.length];
  }

  String? _closest(String w) {
    final limit = w.length >= 8 ? 2 : 1;
    final candidates = <String>{..._synonyms.keys};
    if (w.length >= 5) candidates.addAll(freq.keys);
    String? best;
    var bestD = limit + 1;
    for (final v in candidates) {
      if ((v.length - w.length).abs() > limit) continue;
      final d = _distance(w, v);
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  Map<String, double> _expand(Set<String> words) {
    final out = <String, double>{};
    for (final w in words) {
      var x = w;
      if (!freq.containsKey(x) && x.length >= 4) {
        final fix = _closest(x);
        if (fix != null) x = fix;
      }
      out[x] = 1.0;
      final syn = _synonyms[x];
      if (syn != null) {
        for (final s in syn) {
          out.putIfAbsent(s, () => 0.5);
        }
      }
    }
    return out;
  }

  String _pageText(int n) {
    if (n < 1 || n > pageCount) {
      return 'This PDF has only $pageCount '
          '${pageCount == 1 ? 'page' : 'pages'}. '
          'Please choose a page from 1 to $pageCount.';
    }
    final t = pageTexts[n - 1]
        .replaceAll('\r', '\n')
        .split('\n')
        .map((s) => s.replaceAll(RegExp(r'\s+'), ' ').trim())
        .where((s) => s.isNotEmpty)
        .join('\n');
    if (t.isEmpty) return 'Page $n has no text (it may be a picture).';
    final shown = t.length > 700 ? '${t.substring(0, 700)}...' : t;
    return 'Page $n:\n$shown';
  }

  String? _whichPage(Set<String> topic) {
    final qw = _expand(topic);
    final pageScore = <int, double>{};
    final bestScore = <int, double>{};
    final bestLine = <int, String>{};
    for (var i = 0; i < sentences.length; i++) {
      final sw = _words(sentences[i]).toSet();
      var score = 0.0;
      for (final e in qw.entries) {
        if (sw.contains(e.key)) score += e.value / (freq[e.key] ?? 1);
      }
      if (score <= 0) continue;
      final p = sentencePage[i];
      pageScore[p] = (pageScore[p] ?? 0) + score;
      if (score > (bestScore[p] ?? 0)) {
        bestScore[p] = score;
        bestLine[p] = sentences[i];
      }
    }
    if (pageScore.isEmpty) return null;
    final pages = pageScore.keys.toList()
      ..sort((a, b) {
        final c = pageScore[b]!.compareTo(pageScore[a]!);
        return c != 0 ? c : a.compareTo(b);
      });
    final best = pageScore[pages.first]!;
    final top = pages
        .where((p) => pageScore[p]! >= best * 0.5)
        .take(3)
        .toList();
    final lines = top.map((p) => '(p. ${p + 1}) ${_cut(bestLine[p]!)}');
    final head = top.length == 1
        ? 'Found on page ${top.first + 1}:'
        : 'Found on these pages:';
    return '$head\n\n${lines.join('\n\n')}';
  }

  Reply reply(String q) {
    final core = q
        .toLowerCase()
        .replaceAll(RegExp(r'[^a-z0-9 ]'), ' ')
        .split(' ')
        .where((w) => w.isNotEmpty && !_filler.contains(w))
        .join(' ');

    if (core == 'page' || core == 'pages') {
      return const Reply(
        'Do you want the total number of pages, or the content of one page? '
        'Tap a button, or type a page number like "page 2".',
        [
          ('Total pages', 'How many pages'),
          ('First page', 'first page'),
          ('Last page', 'last page'),
          ('Summarize all', 'Summarize this PDF'),
        ],
      );
    }

    final text = _answerText(q);
    if (text.startsWith('I could not find')) {
      return Reply(text, const [
        ('Summarize', 'Summarize this PDF'),
        ('Key points', 'Give the key points'),
      ]);
    }
    return Reply(text);
  }

  String _lineWithPage(String s) {
    final page = sentencePage[sentences.indexOf(s)];
    return '• (p. ${page + 1}) ${_cut(s)}';
  }

  String _answerText(String q) {
    final ql = q.toLowerCase().trim();

    if (pageCount > 0) {
      if (RegExp(r'\bfirst\s+page\b|\b1st\s+page\b').hasMatch(ql)) {
        return _pageText(1);
      }
      if (RegExp(r'\blast\s+page\b|\bfinal\s+page\b').hasMatch(ql)) {
        return _pageText(pageCount);
      }

      RegExpMatch? match;
      match = RegExp(r'\bpage\s+(\d+)').firstMatch(ql);
      match ??= RegExp(r'\bpage(\d+)').firstMatch(ql);
      match ??= RegExp(r'\b(\d+)\s*(?:st|nd|rd|th)\s+page').firstMatch(ql);
      match ??= RegExp(r'\bpage\s+no\.?\s*(\d+)').firstMatch(ql);
      if (match != null) {
        final num = int.tryParse(match.group(1) ?? '0') ?? 0;
        return _pageText(num);
      }

      if (RegExp(r'^\s*\d+\s*$').hasMatch(ql)) {
        final pageNum = int.tryParse(ql.replaceAll(RegExp(r'\D'), '')) ?? 0;
        if (pageNum > 0) return _pageText(pageNum);
      }

      if (RegExp(
        r'\b(total|how\s+many|number\s+of|count)\s+pages?\b',
      ).hasMatch(ql)) {
        return pageCount == 1
            ? 'This PDF has 1 page.'
            : 'This PDF has $pageCount pages.';
      }

      if (RegExp(r'\b(which|what|where)\s+(page|pages)\b').hasMatch(ql)) {
        final topic = _words(
          ql.replaceAll(RegExp(r'\b(which|what|where|page|pages)\b'), ' '),
        ).toSet();
        if (topic.isNotEmpty) {
          final found = _whichPage(topic);
          if (found != null) return found;
        }
      }
    }

    if (ql.contains('summar')) return _top(4, bullets: false);
    if (ql.contains('key point') || ql.contains('main point')) {
      return _top(6, bullets: true);
    }

    if (ql.contains('phone') || ql.contains('mobile')) {
      final phone = RegExp(r'\+?\d[\d\s\-().]{7,}\d');
      final found = sentences
          .where((s) {
            final m = phone.firstMatch(s);
            return m != null &&
                m.group(0)!.replaceAll(RegExp(r'\D'), '').length >= 9;
          })
          .take(3)
          .toList();
      if (found.isNotEmpty) return found.map(_lineWithPage).join('\n\n');
    }
    if (ql.contains('email') || ql.contains('e-mail')) {
      final mail = RegExp(r'[\w.\-]+@[\w\-]+\.[\w.]+');
      final found = sentences.where((s) => mail.hasMatch(s)).take(3).toList();
      if (found.isNotEmpty) return found.map(_lineWithPage).join('\n\n');
    }

    // Calculations: numbers in the question, or values found in the PDF
    final typed = _typedMath(ql);
    if (typed != null) return typed;
    final fromPdf = _pdfMath(ql);
    if (fromPdf != null) return fromPdf;

    // "Is X there?" questions: answer Yes or No for exactly what was asked
    final askedThere = RegExp(
      r'^\s*(is|are|does|do|any|check)\b.*\b(there|present|available|mentioned?|exists?|contains?|includes?|have|has)\b|\b(is|are) there\b',
    ).hasMatch(ql);
    if (askedThere) {
      const skip = <String>{
        'is',
        'are',
        'does',
        'do',
        'any',
        'check',
        'there',
        'present',
        'available',
        'mention',
        'mentioned',
        'exist',
        'exists',
        'contain',
        'contains',
        'include',
        'includes',
        'have',
        'has',
        'the',
        'an',
        'in',
        'on',
        'this',
        'pdf',
        'file',
        'document',
        'word',
        'text',
        'name',
        'my',
        'me',
        'tell',
        'please',
        'can',
        'you',
        'if',
        'or',
        'not',
        'it',
        'to',
      };
      final targets = ql
          .split(RegExp(r'[^a-z0-9]+'))
          .where((w) => w.length >= 2 && !skip.contains(w))
          .toList();
      if (targets.isNotEmpty) {
        final blocks = <String>[];
        for (final w in targets) {
          final re = RegExp('\\b$w(s|es)?\\b', caseSensitive: false);
          final hit = sentences.indexWhere((x) => re.hasMatch(x));
          if (hit >= 0) {
            blocks.add(
              'Yes, "$w" is in the PDF.\n'
              '• (p. ${sentencePage[hit] + 1}) ${_cut(sentences[hit])}',
            );
          } else {
            final pg = pageTexts.indexWhere((x) => re.hasMatch(x));
            blocks.add(
              pg >= 0
                  ? 'Yes, "$w" is on page ${pg + 1}.'
                  : 'No, "$w" is not in the PDF.',
            );
          }
        }
        return blocks.join('\n\n');
      }
    }

    // Credits: list every course with its credits, then the totals
    if (ql.contains('credit')) {
      const credFiller = <String>{
        'how',
        'many',
        'much',
        'what',
        'is',
        'are',
        'the',
        'of',
        'total',
        'give',
        'show',
        'me',
        'tell',
        'credit',
        'credits',
        'my',
        'a',
        'an',
        'all',
        'please',
        'in',
        'on',
        'for',
        'and',
        'to',
        'i',
        'want',
        'need',
      };
      final extra = ql
          .split(RegExp(r'[^a-z0-9]+'))
          .where((w) => w.isNotEmpty && !credFiller.contains(w));
      if (extra.isEmpty) {
        final row = RegExp(
          r'^(?:(\S+)\s+)?(.+?)\s+([A-Z]{2})\s+(\d\.\d)\s+(O|A\+?|B\+?|C\+?|D|E|F|U|RA)\.?$',
        );
        final lines = <String>[];
        final summary = <String>[];
        for (var i = 0; i < sentences.length; i++) {
          final t = sentences[i].trim();
          final m = row.firstMatch(t);
          if (m != null) {
            lines.add('• ${m.group(2)} — ${m.group(4)} credits');
          } else if (RegExp('credit', caseSensitive: false).hasMatch(t) &&
              RegExp(r'\d').hasMatch(t)) {
            summary.add('• (p. ${sentencePage[i] + 1}) ${_cut(t)}');
          }
        }
        if (lines.isNotEmpty || summary.isNotEmpty) {
          return [
            if (lines.isNotEmpty) lines.join('\n'),
            if (summary.isNotEmpty) summary.join('\n'),
          ].join('\n\n');
        }
      }
    }

    // "grade letter" on a mark sheet: list every course with its grade
    if (ql.contains('grade') &&
        (ql.contains('letter') ||
            ql.contains('grades') ||
            ql.contains('all'))) {
      final row = RegExp(
        r'^(?:(\S+)\s+)?(.+?)\s+([A-Z]{2})\s+(\d\.\d)\s+(O|A\+?|B\+?|C\+?|D|E|F|U|RA)\.?$',
      );
      final lines = <String>[];
      for (final s in sentences) {
        final m = row.firstMatch(s.trim());
        if (m != null) lines.add('• ${m.group(2)} — ${m.group(5)}');
      }
      if (lines.isNotEmpty) return lines.join('\n');
    }

    final queryWords = ql
        .split(RegExp(r'\s+'))
        .where((w) => w.isNotEmpty)
        .toList();
    if (queryWords.isEmpty) return 'Please ask with more words.';

    // One word typed: show only places that really contain it, else say so
    final oneWord = ql
        .split(RegExp(r'[^a-z0-9]+'))
        .where((w) => w.length >= 2 && !_filler.contains(w))
        .toList();
    if (oneWord.length == 1 &&
        oneWord.first.length >= 3 &&
        !_synonyms.containsKey(oneWord.first)) {
      final w = oneWord.first;
      final re = RegExp('\\b$w(s|es)?\\b', caseSensitive: false);
      final hits = <int>[];
      for (var i = 0; i < sentences.length && hits.length < 3; i++) {
        if (re.hasMatch(sentences[i])) hits.add(i);
      }
      if (hits.isNotEmpty) {
        final picked = <int>{};
        for (final i in hits) {
          picked.add(i);
          if (_isHeading(sentences[i])) {
            for (var j = i + 1; j <= i + 2 && j < sentences.length; j++) {
              picked.add(j);
            }
          }
        }
        final pick = picked.toList()..sort();
        return pick
            .map((i) => '• (p. ${sentencePage[i] + 1}) ${_cut(sentences[i])}')
            .join('\n\n');
      }
      final fix = _closest(w);
      final hint = (fix != null && freq.containsKey(fix))
          ? ' Did you mean "$fix"?'
          : '';
      return 'I could not find "$w" in the PDF.$hint';
    }

    final wantsNumber = RegExp(
      r'\b(how many|how much|amount|total|price|cost|percent|rate|number of|size)\b',
    ).hasMatch(ql);

    final scored = <int, double>{};
    for (var i = 0; i < sentences.length; i++) {
      final sentenceWords = RegExp(
        r'[a-z0-9]+',
      ).allMatches(sentences[i].toLowerCase()).map((m) => m.group(0)!).toSet();

      var score = 0.0;
      for (final qw in queryWords) {
        if (_filler.contains(qw) || qw.length < 2) continue;
        if (sentenceWords.contains(qw)) {
          score += 2.0;
        } else {
          for (final sw in sentenceWords) {
            if ((sw.length - qw.length).abs() <= 2) {
              final d = _distance(qw, sw);
              if (d <= 2) score += max(0.0, 1.5 - (d * 0.5));
            }
          }
          final syn = _synonyms[qw];
          if (syn != null) {
            for (final s in syn) {
              if (sentenceWords.contains(s)) score += 1.0;
            }
          }
        }
      }
      if (score > 0 && wantsNumber && RegExp(r'\d').hasMatch(sentences[i])) {
        score *= 2.0;
      }
      if (score > 0 && _isHeading(sentences[i])) score *= 1.5;
      if (score > 0) scored[i] = score;
    }

    if (scored.isEmpty) {
      return 'I could not find "${ql.replaceAll(RegExp(r'[^a-z ]'), '')}" in the PDF. '
          'Try a different word or check the spelling.';
    }

    final best = scored.keys.toList()
      ..sort((a, b) {
        final c = scored[b]!.compareTo(scored[a]!);
        return c != 0 ? c : a.compareTo(b);
      });

    final picked = <int>{};
    final topScore = scored[best.first]!;
    for (final i in best.take(2)) {
      if (scored[i]! < topScore * 0.5) continue;
      picked.add(i);
      if (_isHeading(sentences[i])) {
        for (var j = i + 1; j <= i + 2 && j < sentences.length; j++) {
          picked.add(j);
        }
      }
    }
    if (picked.isEmpty) picked.add(best.first);

    final pick = picked.toList()..sort();
    final results = pick
        .map((i) => '• (p. ${sentencePage[i] + 1}) ${_cut(sentences[i])}')
        .join('\n\n');
    return results.isEmpty
        ? 'No clear matches found. Try different words.'
        : results;
  }

  // ---------- Calculator ----------

  static final _numRe = RegExp(r'(?<![\w.])\d+(?:\.\d+)?(?![\w])');
  static final _courseRowRe = RegExp(
    r'^(?:(\S+)\s+)?(.+?)\s+([A-Z]{2})\s+(\d\.\d)\s+(O|A\+?|B\+?|C\+?|D|E|F|U|RA)\.?$',
  );

  static String _fmt(double v) {
    var s = v.toStringAsFixed(2);
    s = s.replaceFirst(RegExp(r'0+$'), '').replaceFirst(RegExp(r'\.$'), '');
    return s;
  }

  // Works out 2 + 3 * 4 style lists (times and divide first)
  static double? _evalTokens(List<String> t) {
    if (t.isEmpty || t.length.isEven) return null;
    final nums = <double>[];
    final ops = <String>[];
    for (var i = 0; i < t.length; i++) {
      if (i.isEven) {
        final v = double.tryParse(t[i]);
        if (v == null) return null;
        nums.add(v);
      } else {
        if (!'+-*/'.contains(t[i])) return null;
        ops.add(t[i]);
      }
    }
    final n2 = <double>[nums.first];
    final o2 = <String>[];
    for (var i = 0; i < ops.length; i++) {
      if (ops[i] == '*') {
        n2[n2.length - 1] *= nums[i + 1];
      } else if (ops[i] == '/') {
        if (nums[i + 1] == 0) return null;
        n2[n2.length - 1] /= nums[i + 1];
      } else {
        o2.add(ops[i]);
        n2.add(nums[i + 1]);
      }
    }
    var r = n2.first;
    for (var i = 0; i < o2.length; i++) {
      r = o2[i] == '+' ? r + n2[i + 1] : r - n2[i + 1];
    }
    return r;
  }

  // Numbers typed in the question: "12 + 5", "add 4 and 6", "subtract 3 from 10"
  String? _typedMath(String ql) {
    var t = ql
        .replaceAll(',', '')
        .replaceAll(RegExp(r'\bmultiplied by\b|\btimes\b|\binto\b|×'), ' * ')
        .replaceAll(RegExp(r'\bdivided by\b|\bover\b'), ' / ')
        .replaceAll(RegExp(r'\bplus\b'), ' + ')
        .replaceAll(RegExp(r'\bminus\b'), ' - ')
        .replaceAllMapped(RegExp(r'(?<=\d)\s*x\s*(?=\d)'), (_) => ' * ');
    final sb = RegExp(
      r'subtract\s+(\d+(?:\.\d+)?)\s+from\s+(\d+(?:\.\d+)?)',
    ).firstMatch(t);
    if (sb != null) t = '${sb.group(2)} - ${sb.group(1)}';
    final count = RegExp(r'\d+(?:\.\d+)?').allMatches(t).length;
    if (count < 2) return null;
    final hasOp = RegExp(r'\d\s*[+*/]\s*\d|\d\s+-\s+\d').hasMatch(t);
    final toks = RegExp(
      r'\d+(?:\.\d+)?|[+\-*/]',
    ).allMatches(t).map((m) => m.group(0)!).toList();
    if (hasOp) {
      final r = _evalTokens(toks);
      if (r == null) return null;
      final shown = toks.join(' ').replaceAll('*', '×').replaceAll('/', '÷');
      return '$shown = ${_fmt(r)}';
    }
    if (RegExp(r'\b(add|sum|total)\b').hasMatch(t)) {
      final ns = RegExp(
        r'\d+(?:\.\d+)?',
      ).allMatches(t).map((m) => double.parse(m.group(0)!)).toList();
      return '${ns.map(_fmt).join(' + ')} = ${_fmt(ns.reduce((a, b) => a + b))}';
    }
    return null;
  }

  // The number for an item named in the question (a course credit or a lone number)
  (double, String)? _valueOf(String phrase) {
    const drop = <String>{
      'the',
      'of',
      'credit',
      'credits',
      'mark',
      'marks',
      'value',
      'for',
      'in',
      'a',
      'an',
      'my',
      'grade',
      'points',
    };
    final words = phrase
        .split(RegExp(r'[^a-z0-9]+'))
        .where((w) => w.length >= 2 && !drop.contains(w))
        .toList();
    if (words.isEmpty) return null;
    final res = words
        .map((w) => RegExp('\\b$w(s|es)?\\b', caseSensitive: false))
        .toList();
    for (var i = 0; i < sentences.length; i++) {
      final t = sentences[i].trim();
      if (!res.every((r) => r.hasMatch(t))) continue;
      final line = '• (p. ${sentencePage[i] + 1}) ${_cut(t)}';
      final m = _courseRowRe.firstMatch(t);
      if (m != null) return (double.parse(m.group(4)!), line);
      final ns = _numRe.allMatches(t).toList();
      if (ns.length == 1) return (double.parse(ns.first.group(0)!), line);
    }
    return null;
  }

  // Add, subtract, total or average using values found in the PDF
  String? _pdfMath(String ql) {
    final pats = <(RegExp, String)>[
      (RegExp(r'subtract\s+(.+?)\s+from\s+(.+)$'), 'rev'),
      (RegExp(r'difference\s+(?:between\s+)?(.+?)\s+and\s+(.+)$'), 'diff'),
      (RegExp(r'(.+?)\s+(?:minus|-)\s+(.+)$'), 'sub'),
      (
        RegExp(
          r'(?:add|sum(?:\s+of)?|total(?:\s+of)?)\s+(.+?)\s+(?:and|plus|\+)\s+(.+)$',
        ),
        'add',
      ),
      (RegExp(r'(.+?)\s+(?:plus|\+)\s+(.+)$'), 'add'),
    ];
    for (final p in pats) {
      final m = p.$1.firstMatch(ql);
      if (m == null) continue;
      final a = _valueOf(m.group(1)!);
      final b = _valueOf(m.group(2)!);
      if (a == null || b == null) continue;
      final x = p.$2 == 'rev' ? b.$1 : a.$1;
      final y = p.$2 == 'rev' ? a.$1 : b.$1;
      final isAdd = p.$2 == 'add';
      var r = isAdd ? x + y : x - y;
      if (p.$2 == 'diff') r = r.abs();
      final sign = isAdd ? '+' : '-';
      return '${a.$2}\n${b.$2}\n\n${_fmt(x)} $sign ${_fmt(y)} = ${_fmt(r)}';
    }

    if (!RegExp(
      r'\b(calculate|calculation|total|sum|add|average|mean)\b',
    ).hasMatch(ql)) {
      return null;
    }
    const skip = <String>{
      'calculate',
      'calculation',
      'total',
      'sum',
      'add',
      'average',
      'mean',
      'all',
      'the',
      'of',
      'my',
      'me',
      'give',
      'show',
      'tell',
      'please',
      'how',
      'much',
      'many',
      'what',
      'is',
      'are',
      'a',
      'an',
      'in',
      'this',
      'pdf',
      'and',
      'together',
      'whole',
      'full',
      'it',
      'to',
      'for',
    };
    final topic = ql
        .split(RegExp(r'[^a-z0-9]+'))
        .where((w) => w.length >= 2 && !skip.contains(w))
        .toList();
    if (topic.length != 1) return null;
    final avg = RegExp(r'\b(average|mean)\b').hasMatch(ql);

    String finish(List<String> lines, List<double> vals, String label) {
      final total = vals.reduce((a, b) => a + b);
      final expr = vals.map(_fmt).join(' + ');
      final tail = avg
          ? 'Average $label = ($expr) ÷ ${vals.length} = ${_fmt(total / vals.length)}'
          : 'Total $label = $expr = ${_fmt(total)}';
      return '${lines.join('\n')}\n\n$tail';
    }

    if (topic.first.startsWith('credit')) {
      final lines = <String>[];
      final vals = <double>[];
      for (final s in sentences) {
        final m = _courseRowRe.firstMatch(s.trim());
        if (m == null) continue;
        vals.add(double.parse(m.group(4)!));
        lines.add('• ${m.group(2)} — ${m.group(4)}');
      }
      if (vals.isEmpty) return null;
      var out = finish(lines, vals, 'credits');
      final earned = sentences.where(
        (s) => RegExp('credits earned', caseSensitive: false).hasMatch(s),
      );
      if (earned.isNotEmpty && !avg) {
        final n = _numRe.firstMatch(earned.first);
        final total = vals.reduce((a, b) => a + b);
        if (n != null && (double.parse(n.group(0)!) - total).abs() < 0.01) {
          out += '\n(Matches "credits earned" in the PDF.)';
        }
      }
      return out;
    }

    final re = RegExp('\\b${topic.first}(s|es)?\\b', caseSensitive: false);
    final lines = <String>[];
    final vals = <double>[];
    for (var i = 0; i < sentences.length; i++) {
      final t = sentences[i];
      if (!re.hasMatch(t)) continue;
      final ns = _numRe.allMatches(t).toList();
      if (ns.length != 1) continue;
      vals.add(double.parse(ns.first.group(0)!));
      lines.add('• (p. ${sentencePage[i] + 1}) ${_cut(t)}');
    }
    if (vals.length < 2) return null;
    return finish(lines, vals, topic.first);
  }

  String _top(int n, {required bool bullets}) {
    final scores = <int, double>{};
    for (var i = 0; i < sentences.length; i++) {
      final w = _words(sentences[i]);
      if (w.isEmpty || sentences[i].length < 25) continue;
      var s = 0;
      for (final x in w) {
        s += freq[x] ?? 0;
      }
      scores[i] = s / sqrt(w.length);
    }
    if (scores.isEmpty) {
      return sentences
          .take(n)
          .map((s) => bullets ? _lineWithPage(s) : _cut(s))
          .join('\n\n');
    }
    final best = scores.keys.toList()
      ..sort((a, b) {
        final c = scores[b]!.compareTo(scores[a]!);
        return c != 0 ? c : a.compareTo(b);
      });
    final pick = best.take(n).toList()..sort();
    return pick
        .map(
          (i) => bullets
              ? '• (p. ${sentencePage[i] + 1}) ${_cut(sentences[i])}'
              : _cut(sentences[i]),
        )
        .join(bullets ? '\n\n' : ' ');
  }
}

// ---------- Logo ----------

class AppLogo extends StatelessWidget {
  final double size;
  const AppLogo({super.key, this.size = 100});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * 0.25),
        gradient: const LinearGradient(
          colors: [kPrimary, kAccent],
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
        ),
      ),
      child: Stack(
        alignment: Alignment.center,
        children: [
          Icon(
            Icons.description_rounded,
            color: Colors.white,
            size: size * 0.55,
          ),
          Positioned(
            right: size * 0.14,
            bottom: size * 0.14,
            child: Container(
              padding: EdgeInsets.all(size * 0.06),
              decoration: const BoxDecoration(
                color: Colors.white,
                shape: BoxShape.circle,
              ),
              child: Icon(
                Icons.chat_bubble_rounded,
                color: kAccent,
                size: size * 0.2,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------- Screen 1: loading ----------

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key});

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  @override
  void initState() {
    super.initState();
    Future.delayed(const Duration(seconds: 3), () {
      if (!mounted) return;
      Navigator.of(
        context,
      ).pushReplacement(MaterialPageRoute(builder: (_) => const UploadPage()));
    });
  }

  @override
  Widget build(BuildContext context) {
    return const Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            AppLogo(size: 130),
            SizedBox(height: 24),
            Text(
              'DocuChat',
              style: TextStyle(
                fontSize: 34,
                fontWeight: FontWeight.bold,
                color: kPrimary,
              ),
            ),
            SizedBox(height: 8),
            Text(
              'Talk to Any PDF',
              style: TextStyle(fontSize: 16, color: kMuted),
            ),
            SizedBox(height: 32),
            CircularProgressIndicator(),
          ],
        ),
      ),
    );
  }
}

// ---------- Smarter direct answers ----------

extension SmartAnswer on PdfBrain {
  // For "who / when / how many / how much / where" questions, returns ONE best sentence.
  // Everything else uses the normal reply().
  Reply smartReply(String q) {
    final ql = q.toLowerCase().trim();
    if (RegExp(r'page|summar|point|phone|mobile|email|e-mail').hasMatch(ql)) {
      return reply(q);
    }
    final type = RegExp(
      r'^\s*(who|when|how many|how much|where)\b',
    ).firstMatch(ql)?.group(1);
    if (type == null) return reply(q);

    final qw = _expand(PdfBrain._words(ql).toSet());
    var bestI = -1;
    var best = 0.0;
    for (var i = 0; i < sentences.length; i++) {
      final sw = PdfBrain._words(sentences[i]).toSet();
      var s = 0.0;
      for (final e in qw.entries) {
        if (sw.contains(e.key)) s += e.value;
      }
      if (s <= 0) continue;
      final t = sentences[i];
      final bonus = switch (type) {
        'who' => RegExp(r'\b[A-Z][a-z]+ [A-Z][a-z]+').hasMatch(t),
        'when' => RegExp(
          r'\b\d{4}\b|\b\d{1,2}[/-]\d{1,2}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec',
        ).hasMatch(t),
        'how many' || 'how much' => RegExp(r'\d').hasMatch(t),
        _ => false,
      };
      if (bonus) s *= 1.5;
      if (s > best) {
        best = s;
        bestI = i;
      }
    }
    if (bestI < 0 || best < 1.0) return reply(q);
    return Reply('${sentences[bestI]}\n\nPage ${sentencePage[bestI] + 1}');
  }
}


// ---------- Web: choose a PDF ----------

class Msg {
  final String text;
  final bool isUser;
  final List<(String, String)> choices;
  Msg(this.text, this.isUser, {this.choices = const []});
}

class UploadPage extends StatefulWidget {
  const UploadPage({super.key});

  @override
  State<UploadPage> createState() => _UploadPageState();
}

class _UploadPageState extends State<UploadPage> {
  bool _busy = false;

  void _msg(String text) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _pickPdf() async {
    final result = await FilePicker.platform.pickFiles(
      type: FileType.custom,
      allowedExtensions: ['pdf'],
      withData: true,
    );
    if (result == null) return;
    final file = result.files.single;
    final bytes = file.bytes;
    if (bytes == null) {
      _msg('Could not read this file.');
      return;
    }
    setState(() => _busy = true);
    try {
      final pages = await compute(extractPdfText, bytes);
      final brain = PdfBrain(pages);
      if (!mounted) return;
      if (brain.sentences.isEmpty) {
        _msg('No text found. This may be a scanned PDF (only a photo).');
      } else {
        Navigator.of(context).push(
          MaterialPageRoute(
            builder: (_) => ChatPage(fileName: file.name, brain: brain),
          ),
        );
      }
    } catch (e) {
      _msg('Could not open this PDF. It may be locked with a password.');
    }
    if (mounted) setState(() => _busy = false);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SingleChildScrollView(
        child: Column(
          children: [
            Container(
              width: double.infinity,
              padding: const EdgeInsets.fromLTRB(24, 48, 24, 40),
              decoration: const BoxDecoration(
                gradient: LinearGradient(
                  colors: [kPrimary, kAccent],
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                ),
                borderRadius: BorderRadius.vertical(bottom: Radius.circular(36)),
              ),
              child: const Column(
                children: [
                  AppLogo(size: 72),
                  SizedBox(height: 14),
                  Text(
                    'DocuChat',
                    style: TextStyle(
                      color: Colors.white,
                      fontSize: 30,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  SizedBox(height: 6),
                  Text(
                    'Ask questions. Get answers from your PDF.',
                    textAlign: TextAlign.center,
                    style: TextStyle(color: Colors.white70, fontSize: 14),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(24),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Choose your PDF',
                    style: TextStyle(fontSize: 18, fontWeight: FontWeight.w800),
                  ),
                  const SizedBox(height: 14),
                  if (_busy) ...[
                    const LinearProgressIndicator(),
                    const SizedBox(height: 8),
                    const Text('Reading your file...'),
                    const SizedBox(height: 14),
                  ],
                  DropCard(
                    icon: Icons.picture_as_pdf_rounded,
                    title: 'PDF document',
                    hint: 'Tap to choose a PDF from your computer or phone',
                    onTap: _busy ? null : _pickPdf,
                  ),
                  const SizedBox(height: 8),
                  const Center(
                    child: Text(
                      'Free  •  Read in your browser',
                      style: TextStyle(color: kMuted, fontSize: 12),
                    ),
                  ),
                  const SizedBox(height: 6),
                  const Center(
                    child: Text(
                      'Your PDF is read in this browser. Smart mode sends '
                      'your questions to Google only when you turn it on.',
                      textAlign: TextAlign.center,
                      style: TextStyle(color: kMuted, fontSize: 12),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// ---------- Web: chat ----------

class ChatPage extends StatefulWidget {
  final String fileName;
  final PdfBrain brain;
  const ChatPage({super.key, required this.fileName, required this.brain});

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> {
  final TextEditingController _controller = TextEditingController();
  final ScrollController _scroll = ScrollController();
  late final List<Msg> _messages;
  bool _typing = false;
  String? _apiKey = kDefaultKey.isEmpty ? null : kDefaultKey;
  bool _smart = kDefaultKey.isNotEmpty;

  @override
  void initState() {
    super.initState();
    _messages = [
      Msg(
        'Hi! I read "${widget.fileName}" '
        '(${widget.brain.pageCount} pages, ${widget.brain.wordCount} words). '
        'Ask me anything about it, or tap a button below.',
        false,
        choices: const [
          ('Summarize', 'Summarize this PDF'),
          ('Key points', 'Give the key points'),
          ('How many pages', 'How many pages'),
          ('Who wrote this?', 'Who wrote this'),
          ('Phone numbers', 'Show phone numbers'),
          ('Emails', 'Show email addresses'),
        ],
      ),
    ];
  }

  @override
  void dispose() {
    _controller.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _scrollDown() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.animateTo(
          _scroll.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        );
      }
    });
  }

  void _send(String text) {
    final q = text.trim();
    if (q.isEmpty) return;
    setState(() {
      _messages.add(Msg(q, true));
      _controller.clear();
      _typing = true;
    });
    _scrollDown();
    _answer(q);
  }

  Future<void> _answer(String q) async {
    Reply r;
    if (_smart && _apiKey != null) {
      try {
        r = Reply(
          await askAi(
            apiKey: _apiKey!,
            pages: widget.brain.pageTexts,
            question: q,
          ),
        );
      } catch (e) {
        r = Reply(
          'Smart mode failed: $e\n\nOffline answer:\n'
          '${widget.brain.smartReply(q).text}',
        );
      }
    } else {
      await Future.delayed(const Duration(milliseconds: 500));
      r = widget.brain.smartReply(q);
    }
    if (!mounted) return;
    setState(() {
      _typing = false;
      _messages.add(Msg(r.text, false, choices: r.choices));
    });
    _scrollDown();
  }

  Future<void> _toggleSmart() async {
    if (_smart) {
      setState(() => _smart = false);
      return;
    }
    if (_apiKey == null) {
      final c = TextEditingController();
      final key = await showDialog<String>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('Smart mode'),
          content: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const Text(
                'Paste your free Gemini API key (from aistudio.google.com). '
                'Your questions and the document text are sent to Google. '
                'The key is kept only until you close this page.',
              ),
              const SizedBox(height: 12),
              TextField(
                controller: c,
                decoration: const InputDecoration(hintText: 'AIza...'),
              ),
            ],
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, c.text.trim()),
              child: const Text('Use'),
            ),
          ],
        ),
      );
      final cleaned = (key ?? '').replaceAll(RegExp(r'\s'), '');
      if (cleaned.isEmpty) return;
      if (!cleaned.startsWith('AIza') || cleaned.length < 30) {
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('That does not look like a Gemini key (AIza...).'),
          ),
        );
        return;
      }
      _apiKey = cleaned;
    }
    if (!mounted) return;
    setState(() => _smart = true);
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(content: Text('Smart mode is on.')),
    );
  }

  void _copyChat() {
    final text = _messages
        .map((m) => '${m.isUser ? 'Me' : 'DocuChat'}: ${m.text}')
        .join('\n\n');
    Clipboard.setData(ClipboardData(text: text));
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Chat copied'),
        duration: Duration(seconds: 1),
      ),
    );
  }

  Widget _bubble(Msg m, double maxW) {
    final user = m.isUser;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        mainAxisAlignment:
            user ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!user) ...[const AppLogo(size: 32), const SizedBox(width: 8)],
          Flexible(
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: maxW),
              child: Column(
                crossAxisAlignment:
                    user ? CrossAxisAlignment.end : CrossAxisAlignment.start,
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 14,
                      vertical: 11,
                    ),
                    decoration: BoxDecoration(
                      gradient: user
                          ? const LinearGradient(colors: [kPrimary, kAccent])
                          : null,
                      color: user ? null : cardBg(context),
                      borderRadius: BorderRadius.only(
                        topLeft: const Radius.circular(18),
                        topRight: const Radius.circular(18),
                        bottomLeft: Radius.circular(user ? 18 : 4),
                        bottomRight: Radius.circular(user ? 4 : 18),
                      ),
                    ),
                    child: SelectableText(
                      m.text,
                      style: TextStyle(
                        color: user
                            ? Colors.white
                            : (isDark(context) ? Colors.white : Colors.black87),
                        fontSize: 15,
                        height: 1.4,
                      ),
                    ),
                  ),
                  if (!user)
                    IconButton(
                      tooltip: 'Copy',
                      visualDensity: VisualDensity.compact,
                      iconSize: 18,
                      color: kMuted,
                      icon: const Icon(Icons.copy_rounded),
                      onPressed: () {
                        Clipboard.setData(ClipboardData(text: m.text));
                        ScaffoldMessenger.of(context).showSnackBar(
                          const SnackBar(
                            content: Text('Copied'),
                            duration: Duration(seconds: 1),
                          ),
                        );
                      },
                    ),
                  if (m.choices.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Wrap(
                        spacing: 6,
                        runSpacing: 6,
                        children: [
                          for (final c in m.choices)
                            ActionChip(
                              label: Text(c.$1),
                              backgroundColor: kPrimary.withAlpha(20),
                              side: BorderSide.none,
                              labelStyle: const TextStyle(
                                color: kPrimary,
                                fontWeight: FontWeight.w600,
                              ),
                              onPressed: () => _send(c.$2),
                            ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final maxW = MediaQuery.of(context).size.width < 600 ? 300.0 : 560.0;
    return Scaffold(
      appBar: AppBar(
        foregroundColor: Colors.white,
        elevation: 0,
        flexibleSpace: Container(
          decoration: const BoxDecoration(
            gradient: LinearGradient(colors: [kPrimary, kAccent]),
          ),
        ),
        title: Text(
          widget.fileName,
          overflow: TextOverflow.ellipsis,
          style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w700),
        ),
        actions: [
          IconButton(
            tooltip: 'Enter Gemini key',
            icon: const Icon(Icons.vpn_key_outlined),
            onPressed: () {
              setState(() {
                _apiKey = null;
                _smart = false;
              });
              _toggleSmart();
            },
          ),
          IconButton(
            tooltip: 'Smart mode (AI)',
            icon: Icon(
              _smart ? Icons.auto_awesome : Icons.auto_awesome_outlined,
            ),
            onPressed: _toggleSmart,
          ),
          IconButton(
            tooltip: 'Copy chat',
            icon: const Icon(Icons.copy_all_rounded),
            onPressed: _copyChat,
          ),
          IconButton(
            tooltip: 'New PDF',
            icon: const Icon(Icons.add_circle_outline),
            onPressed: () => Navigator.of(context).pop(),
          ),
        ],
      ),
      body: Column(
        children: [
          Expanded(
            child: ListView.builder(
              controller: _scroll,
              padding: const EdgeInsets.all(16),
              itemCount: _messages.length + (_typing ? 1 : 0),
              itemBuilder: (context, i) {
                if (i == _messages.length) {
                  return _bubble(Msg('Thinking...', false), maxW);
                }
                return _bubble(_messages[i], maxW);
              },
            ),
          ),
          SafeArea(
            child: Container(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
              color: cardBg(context),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _controller,
                      textInputAction: TextInputAction.send,
                      decoration: InputDecoration(
                        hintText: 'Ask about your PDF...',
                        filled: true,
                        fillColor: fieldBg(context),
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 18,
                          vertical: 12,
                        ),
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(28),
                          borderSide: BorderSide.none,
                        ),
                      ),
                      onSubmitted: _send,
                    ),
                  ),
                  const SizedBox(width: 8),
                  Container(
                    decoration: const BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: LinearGradient(colors: [kPrimary, kAccent]),
                    ),
                    child: IconButton(
                      color: Colors.white,
                      onPressed: () => _send(_controller.text),
                      icon: const Icon(Icons.send_rounded),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

// ---------- Dashed drop card ----------

class _DashPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = kPrimary.withAlpha(120)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 2;
    final path = Path()
      ..addRRect(
        RRect.fromRectAndRadius(Offset.zero & size, const Radius.circular(24)),
      );
    for (final m in path.computeMetrics()) {
      var d = 0.0;
      while (d < m.length) {
        canvas.drawPath(m.extractPath(d, d + 8), paint);
        d += 14;
      }
    }
  }

  @override
  bool shouldRepaint(covariant CustomPainter oldDelegate) => false;
}

class DropCard extends StatelessWidget {
  final IconData icon;
  final String title;
  final String hint;
  final VoidCallback? onTap;
  const DropCard({
    super.key,
    required this.icon,
    required this.title,
    required this.hint,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Material(
        color: cardBg(context),
        borderRadius: BorderRadius.circular(24),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: CustomPaint(
            painter: _DashPainter(),
            child: SizedBox(
              width: double.infinity,
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  vertical: 26,
                  horizontal: 20,
                ),
                child: Column(
                  children: [
                    Container(
                      padding: const EdgeInsets.all(16),
                      decoration: BoxDecoration(
                        color: kPrimary.withAlpha(20),
                        shape: BoxShape.circle,
                      ),
                      child: Icon(icon, size: 36, color: kPrimary),
                    ),
                    const SizedBox(height: 14),
                    Text(
                      title,
                      style: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w800,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      hint,
                      textAlign: TextAlign.center,
                      style: const TextStyle(color: kMuted),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
