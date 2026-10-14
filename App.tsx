/**
 * Document expiry reader.
 *
 * The user photographs, picks or scans a document; ML Kit reads the text and
 * `extractExpirationDate` finds the expiry date. The user then confirms or
 * corrects it, which matters when the date could be read two ways.
 *
 * @format
 */

import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  PermissionsAndroid,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import {
  launchCamera,
  launchImageLibrary,
  ImagePickerResponse,
} from 'react-native-image-picker';
import DocumentScanner from 'react-native-document-scanner-plugin';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import {
  extractExpirationDate,
  findDatesInText,
  formatDisplay,
} from './src/expirationExtractor';
import type { ExpirationExtraction } from './src/expirationExtractor';
import {
  MAX_PDF_PAGES,
  PdfReadError,
  pickPdf,
  readPdfExpiry,
} from './src/pdfDocument';
import type { PickedPdf } from './src/pdfDocument';

// Document text stays sharp at this size, and OCR is much faster than on a
// full 12-megapixel photo.
const PICKER_OPTIONS = {
  mediaType: 'photo',
  quality: 0.9,
  maxWidth: 2500,
  maxHeight: 2500,
} as const;

type Status = 'idle' | 'reading' | 'done' | 'error';
type Confirmed = { kind: 'date'; iso: string } | { kind: 'lifetime' };
/** What the current result was read from, so "Try again" can repeat it. */
type Source = { kind: 'image'; uri: string } | { kind: 'pdf'; pdf: PickedPdf };

function isoToDisplay(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  return formatDisplay({ year, month, day, raw: iso, precision: 'day', ambiguous: false });
}

function daysUntil(iso: string): number {
  const [year, month, day] = iso.split('-').map(Number);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((new Date(year, month - 1, day).getTime() - today.getTime()) / 86400000);
}

function validityText(iso: string): { text: string; expired: boolean } {
  const days = daysUntil(iso);
  if (days < 0) return { text: `Expired ${-days} day${days === -1 ? '' : 's'} ago`, expired: true };
  if (days === 0) return { text: 'Expires today', expired: false };
  return { text: `Valid · ${days} day${days === 1 ? '' : 's'} left`, expired: false };
}

/** Reads a date the user typed, in any format the extractor understands. */
function parseTypedDate(text: string): string | null {
  const date = findDatesInText(text).find(d => d.precision === 'day') ?? findDatesInText(text)[0];
  if (!date) return null;
  const mm = String(date.month).padStart(2, '0');
  const dd = String(date.day).padStart(2, '0');
  return `${date.year}-${mm}-${dd}`;
}

function uriFromResponse(response: ImagePickerResponse): string | null {
  if (response.didCancel) return null;
  if (response.errorCode) {
    console.log('Image picker error:', response.errorCode, response.errorMessage);
    return null;
  }
  return response.assets?.[0]?.uri ?? null;
}

function App() {
  const isDarkMode = useColorScheme() === 'dark';

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <AppContent />
    </SafeAreaProvider>
  );
}

function AppContent() {
  const safeAreaInsets = useSafeAreaInsets();
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [extraction, setExtraction] = useState<ExpirationExtraction | null>(null);
  const [confirmed, setConfirmed] = useState<Confirmed | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [source, setSource] = useState<Source | null>(null);
  /** "Reading page 2…" while a PDF is processed. */
  const [progress, setProgress] = useState<string | null>(null);
  /** Where in a PDF the result came from, e.g. "Found on page 2 of policy.pdf". */
  const [pdfNote, setPdfNote] = useState<string | null>(null);

  const busy = status === 'reading';

  const startReading = (next: Source) => {
    setSource(next);
    setExtraction(null);
    setConfirmed(null);
    setEditing(false);
    setErrorMessage(null);
    setPdfNote(null);
    setProgress(null);
    setStatus('reading');
  };

  const processImage = async (uri: string) => {
    startReading({ kind: 'image', uri });
    setImageUri(uri);
    try {
      const result = await TextRecognition.recognize(uri);
      const extracted = extractExpirationDate(result.blocks);
      setExtraction(extracted);
      setStatus('done');
      if (__DEV__) {
        console.log('Expiration extraction:', JSON.stringify(extracted, null, 2));
      }
    } catch (err) {
      console.log('ML Kit OCR error:', err);
      setErrorMessage('Could not read text from this image. Try a sharper, well-lit photo.');
      setStatus('error');
    }
  };

  const processPdf = async (pdf: PickedPdf) => {
    startReading({ kind: 'pdf', pdf });
    setImageUri(null);
    try {
      const result = await readPdfExpiry(pdf.uri, page =>
        setProgress(`Reading page ${page} of ${pdf.name}…`),
      );
      const best = result.best;
      // Show the page the date came from (or the first page if none was found).
      const shown = result.pageImages[best?.pageIndex ?? 0];
      setImageUri(shown?.uri ?? null);
      setExtraction(best);
      if (best && best.strategy !== 'none' && result.pageImages.length > 1) {
        setPdfNote(`Found on page ${best.pageIndex + 1} of ${pdf.name}.`);
      } else if (best?.strategy === 'none' && result.morePages) {
        setPdfNote(`Only the first ${MAX_PDF_PAGES} pages of ${pdf.name} were read.`);
      }
      setStatus('done');
      if (__DEV__) {
        console.log('PDF expiration extraction:', JSON.stringify(best, null, 2));
      }
    } catch (err) {
      console.log('PDF read error:', err);
      setErrorMessage(
        err instanceof PdfReadError
          ? err.message
          : 'Could not read this PDF. Try again, or take a photo of the document.',
      );
      setStatus('error');
    } finally {
      setProgress(null);
    }
  };

  const openPdf = async () => {
    try {
      const pdf = await pickPdf();
      if (pdf) processPdf(pdf);
    } catch (err) {
      console.log('PDF picker error:', err);
      Alert.alert(
        'Could not open the file',
        err instanceof PdfReadError ? err.message : 'Try picking the PDF again.',
      );
    }
  };

  const retry = () => {
    if (source?.kind === 'pdf') processPdf(source.pdf);
    else if (source?.kind === 'image') processImage(source.uri);
  };

  const openCamera = async () => {
    let response = await launchCamera(PICKER_OPTIONS);
    // Android only needs the runtime permission when a library declares CAMERA
    // in the manifest, so ask only when the picker reports it is missing.
    if (response.errorCode === 'permission' && Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.CAMERA,
      );
      if (granted === PermissionsAndroid.RESULTS.GRANTED) {
        response = await launchCamera(PICKER_OPTIONS);
      }
    }
    if (response.errorCode === 'permission') {
      Alert.alert(
        'Camera permission needed',
        'Allow camera access in Settings to photograph your document.',
      );
      return;
    }
    if (response.errorCode === 'camera_unavailable') {
      Alert.alert('No camera available', 'Pick a photo from the gallery instead.');
      return;
    }
    const uri = uriFromResponse(response);
    if (uri) processImage(uri);
  };

  // The system photo picker needs no storage permission on Android or iOS.
  const openGallery = async () => {
    const response = await launchImageLibrary({ ...PICKER_OPTIONS, selectionLimit: 1 });
    const uri = uriFromResponse(response);
    if (uri) processImage(uri);
  };

  const scanDocument = async () => {
    try {
      const { scannedImages } = await DocumentScanner.scanDocument({
        maxNumDocuments: 1,
      });
      const uri = scannedImages?.[0];
      if (uri) processImage(uri);
    } catch (err) {
      console.log('Document scanner error:', err);
      // Closing the scanner is not an error worth showing.
      if (!/cancel/i.test(String(err))) {
        Alert.alert('Scanner unavailable', 'Try taking a photo instead.');
      }
    }
  };

  const confirmDate = (iso: string) => {
    setConfirmed({ kind: 'date', iso });
    setEditing(false);
    // Save the confirmed expiry date here (API call, storage, reminder, ...).
    console.log('Confirmed expiry date:', iso);
  };

  const confirmLifetime = () => {
    setConfirmed({ kind: 'lifetime' });
    setEditing(false);
    console.log('Confirmed: document never expires');
  };

  const startEditing = () => {
    setDraft(confirmed?.kind === 'date' ? confirmed.iso : extraction?.iso ?? '');
    setEditing(true);
  };

  const handleReset = () => {
    setImageUri(null);
    setExtraction(null);
    setConfirmed(null);
    setEditing(false);
    setErrorMessage(null);
    setSource(null);
    setPdfNote(null);
    setProgress(null);
    setStatus('idle');
  };

  const typedIso = editing ? parseTypedDate(draft) : null;

  const renderConfirmed = (value: Confirmed) => {
    if (value.kind === 'lifetime') {
      return (
        <>
          <Text style={styles.cardTitle}>Expiry date confirmed</Text>
          <Text style={styles.dateValue}>Never expires</Text>
        </>
      );
    }
    const validity = validityText(value.iso);
    return (
      <>
        <Text style={styles.cardTitle}>Expiry date confirmed</Text>
        <Text style={styles.dateValue}>{isoToDisplay(value.iso)}</Text>
        <Text style={[styles.validity, validity.expired && styles.expired]}>
          {validity.text}
        </Text>
      </>
    );
  };

  const renderEditor = () => (
    <>
      <Text style={styles.cardTitle}>Enter the expiry date</Text>
      <TextInput
        style={styles.input}
        value={draft}
        onChangeText={setDraft}
        placeholder="e.g. 15/03/2030 or 15 Mar 2030"
        autoFocus
      />
      <Text style={styles.hint}>
        {draft.trim() === ''
          ? 'Day first, e.g. 05/03/2030 is 5 March 2030.'
          : typedIso
            ? `Will be saved as ${isoToDisplay(typedIso)}`
            : 'Not a date yet'}
      </Text>
      <View style={styles.row}>
        <TouchableOpacity
          style={[styles.button, !typedIso && styles.buttonDisabled]}
          disabled={!typedIso}
          onPress={() => typedIso && confirmDate(typedIso)}
        >
          <Text style={styles.buttonText}>Save</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, styles.secondaryButton]}
          onPress={() => setEditing(false)}
        >
          <Text style={styles.secondaryButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    </>
  );

  const renderExtraction = (result: ExpirationExtraction) => {
    if (result.noExpiry) {
      return (
        <>
          <Text style={styles.cardTitle}>Expiry date</Text>
          <Text style={styles.dateValue}>Never expires</Text>
          <Text style={styles.hint}>The document says “{result.sourceLine}”.</Text>
          <View style={styles.row}>
            <TouchableOpacity style={styles.button} onPress={confirmLifetime}>
              <Text style={styles.buttonText}>Looks right</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.button, styles.secondaryButton]}
              onPress={startEditing}
            >
              <Text style={styles.secondaryButtonText}>Enter a date</Text>
            </TouchableOpacity>
          </View>
        </>
      );
    }

    if (!result.iso) {
      return (
        <>
          <Text style={styles.cardTitle}>Expiry date</Text>
          <Text style={styles.missing}>No expiry date found on this document.</Text>
          <Text style={styles.hint}>
            Receipts and certificates often have none. If this document does
            expire, enter the date yourself or try a clearer photo.
          </Text>
          <View style={styles.row}>
            <TouchableOpacity style={styles.button} onPress={startEditing}>
              <Text style={styles.buttonText}>Enter date</Text>
            </TouchableOpacity>
          </View>
        </>
      );
    }

    const iso = result.iso;
    const validity = validityText(iso);
    return (
      <>
        <Text style={styles.cardTitle}>Expiry date</Text>
        <Text style={styles.dateValue}>{result.display}</Text>
        <Text style={[styles.validity, validity.expired && styles.expired]}>
          {validity.text}
        </Text>

        {result.ambiguous && result.alternativeIso ? (
          <>
            <Text style={styles.warning}>
              “{result.date?.raw}” can be read two ways. Which one is on the document?
            </Text>
            <View style={styles.row}>
              <TouchableOpacity style={styles.button} onPress={() => confirmDate(iso)}>
                <Text style={styles.buttonText}>{isoToDisplay(iso)}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.button}
                onPress={() => result.alternativeIso && confirmDate(result.alternativeIso)}
              >
                <Text style={styles.buttonText}>{isoToDisplay(result.alternativeIso)}</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <>
            {result.confidence !== 'high' ? (
              <Text style={styles.warning}>Please check this matches the document.</Text>
            ) : null}
            <View style={styles.row}>
              <TouchableOpacity style={styles.button} onPress={() => confirmDate(iso)}>
                <Text style={styles.buttonText}>Looks right</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.button, styles.secondaryButton]}
                onPress={startEditing}
              >
                <Text style={styles.secondaryButtonText}>Edit</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </>
    );
  };

  return (
    <View style={[styles.container, { paddingTop: safeAreaInsets.top }]}>
      <View style={styles.buttonContainer}>
        <TouchableOpacity
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={openCamera}
          disabled={busy}
        >
          <Text style={styles.buttonText}>📷 Capture Photo</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={openGallery}
          disabled={busy}
        >
          <Text style={styles.buttonText}>🖼️ Pick from Gallery</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={scanDocument}
          disabled={busy}
        >
          <Text style={styles.buttonText}>📄 Scan Document</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={openPdf}
          disabled={busy}
        >
          <Text style={styles.buttonText}>📑 Pick PDF</Text>
        </TouchableOpacity>
        {source && !busy ? (
          <TouchableOpacity
            style={[styles.button, styles.resetButton]}
            onPress={handleReset}
          >
            <Text style={styles.buttonText}>↺ Start Over</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      <ScrollView
        style={styles.scrollContent}
        contentContainerStyle={styles.scrollContentContainer}
        keyboardShouldPersistTaps="handled"
      >
        {imageUri ? (
          <View style={styles.imageContainer}>
            <Image source={{ uri: imageUri }} style={styles.image} resizeMode="contain" />
          </View>
        ) : !source ? (
          <Text style={styles.placeholder}>
            Photograph, pick, scan or open a PDF of a document to read its expiry date.
          </Text>
        ) : null}

        {status === 'reading' ? (
          <View style={styles.card}>
            <ActivityIndicator size="large" />
            <Text style={styles.hint}>{progress ?? 'Reading document…'}</Text>
          </View>
        ) : null}

        {status === 'error' && source ? (
          <View style={styles.card}>
            <Text style={styles.missing}>{errorMessage}</Text>
            <View style={styles.row}>
              <TouchableOpacity style={styles.button} onPress={retry}>
                <Text style={styles.buttonText}>Try again</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : null}

        {status === 'done' && extraction ? (
          <View style={styles.card}>
            {editing
              ? renderEditor()
              : confirmed
                ? renderConfirmed(confirmed)
                : renderExtraction(extraction)}

            {pdfNote && !editing ? <Text style={styles.hint}>{pdfNote}</Text> : null}

            {confirmed && !editing ? (
              <TouchableOpacity onPress={startEditing}>
                <Text style={styles.link}>Change</Text>
              </TouchableOpacity>
            ) : null}

            {__DEV__ ? (
              <Text style={styles.debug}>
                {extraction.strategy} · {extraction.confidence ?? 'no result'} · order{' '}
                {extraction.dateOrder} ({extraction.dateOrderSource})
                {extraction.sourceLine ? `\n“${extraction.sourceLine}”` : ''}
              </Text>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  buttonContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 12,
    paddingBottom: 16,
    gap: 10,
    flexWrap: 'wrap',
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 12,
  },
  button: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    minWidth: 140,
    alignItems: 'center',
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  secondaryButton: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  secondaryButtonText: {
    color: '#007AFF',
    fontSize: 14,
    fontWeight: '600',
  },
  resetButton: {
    backgroundColor: '#FF3B30',
  },
  scrollContent: {
    flex: 1,
  },
  scrollContentContainer: {
    flexGrow: 1,
    paddingBottom: 100,
  },
  placeholder: {
    marginTop: 40,
    paddingHorizontal: 32,
    textAlign: 'center',
    fontSize: 15,
    color: '#666',
  },
  imageContainer: {
    height: 220,
    paddingHorizontal: 20,
    paddingVertical: 8,
  },
  image: {
    width: '100%',
    height: '100%',
  },
  card: {
    margin: 12,
    padding: 16,
    backgroundColor: '#F0F8FF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#34C759',
  },
  cardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#34C759',
    marginBottom: 6,
  },
  dateValue: {
    fontSize: 26,
    fontWeight: '700',
    color: '#111',
    marginBottom: 4,
  },
  validity: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1E8E3E',
  },
  expired: {
    color: '#FF3B30',
  },
  warning: {
    marginTop: 12,
    fontSize: 13,
    color: '#8A5A00',
  },
  missing: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FF3B30',
    marginBottom: 6,
  },
  hint: {
    marginTop: 6,
    fontSize: 13,
    color: '#555',
  },
  input: {
    borderWidth: 1,
    borderColor: '#bbb',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    backgroundColor: '#fff',
    color: '#111',
  },
  link: {
    marginTop: 12,
    color: '#007AFF',
    fontSize: 14,
    fontWeight: '600',
  },
  debug: {
    marginTop: 14,
    fontSize: 11,
    color: '#888',
  },
});

export default App;
