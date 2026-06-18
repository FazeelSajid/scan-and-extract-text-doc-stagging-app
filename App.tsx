/**
 * Sample React Native App
 * https://github.com/facebook/react-native
 *
 * @format
 */

import { useState } from 'react';
import {
  StatusBar,
  StyleSheet,
  useColorScheme,
  View,
  Text,
  TouchableOpacity,
  Image,
  PermissionsAndroid,
  Platform,
  Alert,
  ScrollView,
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
import { recognize } from 'react-native-nitro-ocr';
import TextRecognition from '@react-native-ml-kit/text-recognition';
import {
  extractExpirationDate,
  ExpirationExtraction,
} from './src/expirationExtractor';

type MlKitFrame = { top?: number; left?: number; x?: number; y?: number };
type MlKitLine = { text: string; frame?: MlKitFrame };
type MlKitBlock = { lines?: MlKitLine[] };

function getFrameTop(frame?: MlKitFrame): number {
  return frame?.top ?? frame?.y ?? 0;
}

function getFrameLeft(frame?: MlKitFrame): number {
  return frame?.left ?? frame?.x ?? 0;
}

function getMlKitLinesTopToBottom(blocks: MlKitBlock[]): MlKitLine[] {
  return blocks
    .flatMap(block => block.lines ?? [])
    .sort((a, b) => {
      const topDiff = getFrameTop(a.frame) - getFrameTop(b.frame);
      return topDiff !== 0 ? topDiff : getFrameLeft(a.frame) - getFrameLeft(b.frame);
    });
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
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [scannedDocument, setScannedDocument] = useState<string | null>(null);
  const [ocrResult, setOcrResult] = useState<{
    text: string;
    blocks: any[];
  } | null>(null);
  const [mlKitResult, setMlKitResult] = useState<{
    text: string;
    blocks: MlKitBlock[];
  } | null>(null);
  const [expiration, setExpiration] = useState<ExpirationExtraction | null>(null);

  const requestCameraPermission = async (): Promise<boolean> => {
    if (Platform.OS === 'android') {
      try {
        const granted = await PermissionsAndroid.request(
          PermissionsAndroid.PERMISSIONS.CAMERA,
          {
            title: 'Camera Permission',
            message: 'This app needs access to your camera to take photos.',
            buttonNeutral: 'Ask Me Later',
            buttonNegative: 'Cancel',
            buttonPositive: 'OK',
          },
        );
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } catch (err) {
        console.warn('Camera permission error:', err);
        return false;
      }
    }
    return true;
  };

  const requestGalleryPermission = async (): Promise<boolean> => {
    if (Platform.OS === 'android') {
      const permission =
        Platform.Version >= 33
          ? PermissionsAndroid.PERMISSIONS.READ_MEDIA_IMAGES
          : PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE;

      try {
        const granted = await PermissionsAndroid.request(permission);
        return granted === PermissionsAndroid.RESULTS.GRANTED;
      } catch (err) {
        console.warn('Gallery permission error:', err);
        return false;
      }
    }
    return true;
  };

  const handleImageResponse = (response: ImagePickerResponse) => {
    if (response.didCancel) {
      console.log('User cancelled image picker');
    } else if (response.errorCode) {
      console.log('Image picker error:', response.errorMessage);
    } else if (response.assets && response.assets.length > 0) {
      setSelectedImage(response.assets[0].uri || null);
    }
  };

  const scanDocument = async () => {
    try {
      const { scannedImages } = await DocumentScanner.scanDocument({
        maxNumDocuments: 1,
      });
      if (scannedImages && scannedImages.length > 0) {
        setScannedDocument(scannedImages[0]);
      }
    } catch (err) {
      console.log('Document scanner error:', err);
    }
  };

  const openCamera = async () => {
    launchCamera({ mediaType: 'photo', quality: 1 }, handleImageResponse);

    // const hasPermission = await requestCameraPermission();
    // if (hasPermission) {
    //   launchCamera({ mediaType: 'photo', quality: 1 }, handleImageResponse);
    // } else {
    //   Alert.alert(
    //     'Permission Denied',
    //     'Camera permission is required to take photos. Please enable it in Settings.',
    //     [{ text: 'OK' }],
    //   );
    // }
  };

  const openGallery = async () => {
    const hasPermission = await requestGalleryPermission();
    if (hasPermission) {
      launchImageLibrary(
        { mediaType: 'photo', quality: 1 },
        handleImageResponse,
      );
    } else {
      Alert.alert(
        'Permission Denied',
        'Gallery permission is required to select photos. Please enable it in Settings.',
        [{ text: 'OK' }],
      );
    }
  };

  const recognizeText = async () => {
    const imageUri = scannedDocument || selectedImage;
    if (!imageUri) {
      Alert.alert('No Image', 'Please capture or select an image first.');
      return;
    }

    try {
      const result = await recognize(imageUri);
      setOcrResult(result);

      if (result.blocks) {
        for (const block of result.blocks) {
          for (const line of block.lines) {
            console.log(
              'Text:',
              line.text,
              '| Confidence:',
              line.confidence,
              '| BoundingBox:',
              JSON.stringify(line.boundingBox),
            );
          }
        }
      }
    } catch (err) {
      console.log('OCR error:', err);
      setOcrResult({ text: 'OCR failed. Please try again.', blocks: [] });
    }
  };

  const recognizeWithMLKit = async () => {
    const imageUri = scannedDocument || selectedImage;
    if (!imageUri) {
      Alert.alert('No Image', 'Please capture or select an image first.');
      return;
    }

    try {
      const result = await TextRecognition.recognize(imageUri);
      setMlKitResult({ text: result.text, blocks: result.blocks });

      for (const block of result.blocks) {
        for (const line of block.lines) {
          console.log(
            'ML Kit - Text:',
            line.text,
            '| Frame:',
            JSON.stringify(line.frame),
          );
        }
      }

      // Run expiration-date extraction over the recognized blocks.
      const extracted = extractExpirationDate(result.blocks);
      setExpiration(extracted);
      console.log(
        'Expiration extraction:',
        JSON.stringify(extracted, null, 2),
      );
    } catch (err) {
      console.log('ML Kit OCR error:', err);
      setMlKitResult({ text: 'OCR failed. Please try again.', blocks: [] });
      setExpiration(null);
    }
  };

  const handleReset = () => {
    setSelectedImage(null);
    setScannedDocument(null);
    setOcrResult(null);
    setMlKitResult(null);
    setExpiration(null);
  };

  const hasContent =
    selectedImage || scannedDocument || ocrResult || mlKitResult;
  const showActionButtons = !mlKitResult;
  const hasAnyOcrResult = ocrResult || mlKitResult;

  return (
    <View style={[styles.container, { paddingTop: safeAreaInsets.top }]}>
      {showActionButtons ? (
        <View style={styles.buttonContainer}>
          <TouchableOpacity style={styles.button} onPress={openCamera}>
            <Text style={styles.buttonText}>📷 Capture Photo</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={openGallery}>
            <Text style={styles.buttonText}>Pick from Gallery</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={scanDocument}>
            <Text style={styles.buttonText}>📄 Scan Document</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={recognizeText}>
            <Text style={styles.buttonText}>🔍 Nitro OCR</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={recognizeWithMLKit}>
            <Text style={styles.buttonText}>🤖 ML Kit OCR</Text>
          </TouchableOpacity>
          {hasContent && (
            <TouchableOpacity
              style={[styles.button, styles.resetButton]}
              onPress={handleReset}
            >
              <Text style={styles.buttonText}>↺ Reset</Text>
            </TouchableOpacity>
          )}
        </View>
      ) : (
        hasContent && (
          <View style={styles.resetBar}>
            <TouchableOpacity
              style={[styles.button, styles.resetButton]}
              onPress={handleReset}
            >
              <Text style={styles.buttonText}>↺ Reset</Text>
            </TouchableOpacity>
          </View>
        )
      )}

      <ScrollView
        style={styles.scrollContent}
        contentContainerStyle={styles.scrollContentContainer}
      >
        {(scannedDocument || selectedImage) && (
          <View
            style={[
              styles.imageContainer,
              hasAnyOcrResult && styles.imageContainerCompact,
            ]}
          >
            <Image
              source={{ uri: (scannedDocument || selectedImage) ?? undefined }}
              style={styles.image}
              resizeMode="contain"
            />
          </View>
        )}

        {/* <View style={[styles.ocrColumn, styles.mlKitColumn]}>
          <Text style={styles.mlKitTitle}>ML Kit OCR</Text>
          <ScrollView style={styles.ocrScroll} nestedScrollEnabled>
            {mlKitResult?.blocks?.length ? (
              getMlKitLinesTopToBottom(mlKitResult.blocks).map(
                (line, index) => (
                  <View key={`mlkit-line-${index}`} style={styles.mlKitLineItem}>
                    <Text style={styles.lineText}>{line.text}</Text>
                  </View>
                ),
              )
            ) : (
              <Text style={styles.ocrText}>
                {mlKitResult?.text || 'Run ML Kit OCR to see results'}
              </Text>
            )}
          </ScrollView>
        </View> */}

        {expiration && (
          <View style={styles.expirationCard}>
            <Text style={styles.mlKitTitle}>ML Kit OCR</Text>
            <Text style={styles.expirationTitle}>Expiration Date</Text>
            {expiration.iso ? (
              <>
                <Text style={styles.expirationValue}>{expiration.display}</Text>
                <Text style={styles.expirationIso}>ISO: {expiration.iso}</Text>
              </>
            ) : (
              <Text style={styles.expirationMissing}>
                Could not detect an expiration date. Strategy: {expiration.strategy}
              </Text>
            )}
            {expiration.sourceLine ? (
              <Text style={styles.expirationSource}>
                Source: "{expiration.sourceLine}"
              </Text>
            ) : null}
            <Text style={styles.expirationStrategy}>
              Strategy: {expiration.strategy}
            </Text>
          </View>
        )}
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
    paddingBottom: 20,
    gap: 10,
    flexWrap: 'wrap',
  },
  button: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
    minWidth: 140,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
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
  resetBar: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  imageContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
  },
  imageContainerCompact: {
    flex: 0,
    maxHeight: 180,
    paddingVertical: 8,
  },
  image: {
    width: '100%',
    height: '100%',
    maxHeight: 500,
  },
  ocrColumn: {
    flex: 1,
    padding: 12,
  },
  mlKitColumn: {
    backgroundColor: '#f9f9f9',
  },
  ocrScroll: {},
  ocrText: {
    fontSize: 14,
    color: '#333',
    marginBottom: 16,
  },
  mlKitTitle: {
    fontSize: 14,
    fontWeight: '700',
    marginBottom: 8,
    color: '#34C759',
  },
  mlKitLineItem: {
    marginBottom: 8,
    paddingLeft: 8,
    borderLeftWidth: 2,
    borderLeftColor: '#34C759',
  },
  lineText: {
    fontSize: 14,
    fontWeight: '500',
    color: '#222',
  },
  expirationCard: {
    margin: 12,
    padding: 16,
    backgroundColor: '#F0F8FF',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#34C759',
  },
  expirationTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: '#34C759',
    marginBottom: 6,
  },
  expirationValue: {
    fontSize: 24,
    fontWeight: '700',
    color: '#111',
    marginBottom: 4,
  },
  expirationIso: {
    fontSize: 12,
    color: '#555',
    marginBottom: 8,
  },
  expirationMissing: {
    fontSize: 14,
    color: '#FF3B30',
    marginBottom: 8,
  },
  expirationSource: {
    fontSize: 12,
    color: '#444',
    marginBottom: 4,
    fontStyle: 'italic',
  },
  expirationStrategy: {
    fontSize: 11,
    color: '#888',
    marginTop: 4,
  },
});

export default App;
