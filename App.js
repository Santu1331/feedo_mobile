import React, { useEffect, useRef, useState } from 'react';
import {
  StyleSheet, View,
  Platform, BackHandler, Text, PermissionsAndroid,
  StatusBar, Animated
} from 'react-native';
import { WebView } from 'react-native-webview';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

// ─────────────────────────────────────────────
//  NOTIFICATION HANDLER (foreground display)
// ─────────────────────────────────────────────
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

const WEBSITE_URL = 'https://feedo-ruddy.vercel.app/';

// ─────────────────────────────────────────────
//  REGISTER ACCEPT / VIEW ACTION BUTTONS
//  These show on the notification itself —
//  even on lock screen and when app is closed
// ─────────────────────────────────────────────
async function registerNotificationCategories() {
  await Notifications.setNotificationCategoryAsync('NEW_ORDER', [
    {
      identifier: 'ACCEPT',
      buttonTitle: '✅ Accept',
      options: { opensAppToForeground: false }, // accepts silently, no app open
    },
    {
      identifier: 'VIEW',
      buttonTitle: '👁 View Order',
      options: { opensAppToForeground: true },  // opens app to order page
    },
  ]);
}

// ─────────────────────────────────────────────
//  LOCATION PERMISSION
// ─────────────────────────────────────────────
async function requestLocationPermission() {
  if (Platform.OS === 'android') {
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        {
          title: 'FeedoZone Location Permission',
          message: 'FeedoZone needs your location to show nearby restaurants and calculate delivery charges.',
          buttonNeutral: 'Ask Me Later',
          buttonNegative: 'Cancel',
          buttonPositive: 'Allow',
        }
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } catch (err) {
      return false;
    }
  }
  return true;
}

// ─────────────────────────────────────────────
//  PUSH NOTIFICATION REGISTRATION
//  Channel first → permission → token
// ─────────────────────────────────────────────
async function registerForPushNotifications() {
  if (!Device.isDevice) {
    console.log('Push notifications require a physical device');
    return null;
  }

  // Step 1 — Create channel FIRST (required on Android 13+)
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#E24B4A',
    });
  }

  // Step 2 — Request permission
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    console.log('Notification permission denied');
    return null;
  }

  // Step 3 — Get Expo push token
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) {
    console.log('ERROR: projectId missing from app.json');
    return null;
  }

  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    console.log('✅ Push token:', token);
    return token;
  } catch (error) {
    console.log('ERROR getting push token:', error);
    return null;
  }
}

// ─────────────────────────────────────────────
//  APP
// ─────────────────────────────────────────────
export default function App() {
  const webViewRef = useRef(null);
  const [currentUrl, setCurrentUrl] = useState(WEBSITE_URL);
  const [loading, setLoading] = useState(true);
  const [splashVisible, setSplashVisible] = useState(true);
  const [expoPushToken, setExpoPushToken] = useState('');
  const [webViewReady, setWebViewReady] = useState(false);
  const notificationListener = useRef();
  const responseListener = useRef();
  const fadeAnim = useRef(new Animated.Value(1)).current;
  const scaleAnim = useRef(new Animated.Value(0.8)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  const injectTokenScript = (token) => {
    if (!webViewRef.current) return;
    const script = `
      (function() {
        var token = '${token}';
        window.expoPushToken = token;
        try { localStorage.setItem('expoPushToken', token); } catch(e) {}
        window.dispatchEvent(new CustomEvent('expoPushToken', { detail: token }));
        console.log('FeedoZone token injected: ' + token);
      })();
      true;
    `;
    webViewRef.current.injectJavaScript(script);
  };

  // ── MAIN SETUP ──────────────────────────────
  useEffect(() => {
    // Register Accept / View buttons on every app start
    registerNotificationCategories();

    // Splash animation
    Animated.parallel([
      Animated.spring(scaleAnim, {
        toValue: 1,
        tension: 50,
        friction: 7,
        useNativeDriver: true,
      }),
      Animated.timing(progressAnim, {
        toValue: 1,
        duration: 2200,
        useNativeDriver: false,
      }),
    ]).start();

    const splashTimer = setTimeout(() => {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }).start(() => setSplashVisible(false));
    }, 2600);

    requestLocationPermission();

    // Check if the app was launched by a notification click (killed state)
    Notifications.getLastNotificationResponseAsync().then(response => {
      if (response) {
        const data = response.notification.request.content.data;
        const orderId = data?.orderId;
        const url = data?.url;

        if (orderId) {
          setCurrentUrl(`${WEBSITE_URL}vendor/orders/${orderId}`);
        } else if (url) {
          setCurrentUrl(url.startsWith('http') ? url : `${WEBSITE_URL}${url.startsWith('/') ? url.slice(1) : url}`);
        }
      }
    }).catch(err => console.log('Error getting last notification response:', err));

    // Register push token
    registerForPushNotifications().then(token => {
      if (token) {
        setExpoPushToken(token);
      }
    });

    // Foreground notification listener (just log)
    notificationListener.current = Notifications.addNotificationReceivedListener(notification => {
      console.log('📩 Notification received in foreground:', notification);
    });

    // ── ACTION BUTTON HANDLER ──────────────────
    // Fires when vendor taps Accept, View, or the notification itself
    // Works when app is closed, backgrounded, or phone is locked
    responseListener.current = Notifications.addNotificationResponseReceivedListener(response => {
      const { actionIdentifier } = response;
      const data = response.notification.request.content.data;
      const orderId = data?.orderId;

      // ── Vendor tapped "✅ Accept" ──
      // Silently accepts the order without opening the app
      if (actionIdentifier === 'ACCEPT' && orderId) {
        fetch(`https://feedo-ruddy.vercel.app/api/accept-order`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId }),
        })
          .then(res => console.log('✅ Order accepted API call:', orderId, res.status))
          .catch(err => console.log('❌ Accept API call failed:', err));
        return;
      }

      // ── Vendor tapped "👁 View Order" or tapped notification body ──
      // Opens app and navigates to order details page
      if (
        (actionIdentifier === 'VIEW' ||
          actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER) &&
        orderId
      ) {
        if (webViewRef.current) {
          webViewRef.current.injectJavaScript(
            `window.location.href = '/vendor/orders/${orderId}'; true;`
          );
        }
        return;
      }

      // ── Fallback: use url field from notification data ──
      const url = data?.url;
      if (url && webViewRef.current) {
        webViewRef.current.injectJavaScript(
          `window.location.href = '${url}'; true;`
        );
      }
    });

    return () => {
      clearTimeout(splashTimer);
      Notifications.removeNotificationSubscription(notificationListener.current);
      Notifications.removeNotificationSubscription(responseListener.current);
    };
  }, []);

  // ── INJECT TOKEN INTO WEBSITE ────────────────
  // Runs when both token is ready AND webview has loaded
  useEffect(() => {
    if (expoPushToken && webViewReady) {
      injectTokenScript(expoPushToken);
      // Inject again after 2s as safety net for slow page loads
      const timer = setTimeout(() => {
        injectTokenScript(expoPushToken);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [expoPushToken, webViewReady]);

  // ── ANDROID BACK BUTTON ──────────────────────
  useEffect(() => {
    if (Platform.OS === 'android') {
      const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
        if (webViewRef.current) {
          webViewRef.current.goBack();
          return true;
        }
        return false;
      });
      return () => backHandler.remove();
    }
  }, []);

  // ── INJECTED JS (runs on every page load) ────
  const injectedJS = `
    (function() {
      var meta = document.querySelector('meta[name="viewport"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'viewport';
        document.head.appendChild(meta);
      }
      meta.content = 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no';

      var style = document.createElement('style');
      style.innerHTML = '::-webkit-scrollbar { display: none; } body { overflow-x: hidden; }';
      document.head.appendChild(style);

      try {
        var savedToken = localStorage.getItem('expoPushToken');
        if (savedToken) {
          window.expoPushToken = savedToken;
          window.dispatchEvent(new CustomEvent('expoPushToken', { detail: savedToken }));
          console.log('Token restored from localStorage: ' + savedToken);
        }
      } catch(e) {}
    })();
    true;
  `;

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  // ── RENDER ───────────────────────────────────
  return (
    <SafeAreaProvider>
      <StatusBar
        backgroundColor="#E24B4A"
        barStyle="light-content"
        translucent={false}
      />

      <SafeAreaView style={styles.safeArea} edges={['top']}>
        <View style={styles.container}>

          <WebView
            ref={webViewRef}
            source={{ uri: currentUrl }}
            style={styles.webview}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => {
              setLoading(false);
              setWebViewReady(true);
            }}
            injectedJavaScript={injectedJS}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            allowsBackForwardNavigationGestures={true}
            geolocationEnabled={true}
            allowsInlineMediaPlayback={true}
            mediaPlaybackRequiresUserAction={false}
            onPermissionRequest={(request) => request.grant()}
            mixedContentMode="compatibility"
            thirdPartyCookiesEnabled={true}
            sharedCookiesEnabled={true}
            onMessage={(event) => {
              try {
                const message = JSON.parse(event.nativeEvent.data);
                if (message.type === 'GET_PUSH_TOKEN' && expoPushToken) {
                  injectTokenScript(expoPushToken);
                }
              } catch (err) {
                console.log('Error parsing WebView message:', err);
              }
            }}
          />

          {loading && !splashVisible && (
            <View style={styles.loadingBar}>
              <View style={styles.loadingBarFill} />
            </View>
          )}

          {splashVisible && (
            <Animated.View style={[styles.splash, { opacity: fadeAnim }]}>
              <View style={styles.splashTopCircle} />
              <View style={styles.splashBottomCircle} />

              <Animated.View style={[styles.splashLogoContainer, { transform: [{ scale: scaleAnim }] }]}>
                <View style={styles.splashIconBox}>
                  <Text style={styles.splashWordLogo}>feedO</Text>
                </View>
                <Text style={styles.splashTitle}>FeedoZone</Text>
                <Text style={styles.splashTagline}>Food at your doorstep 🚀</Text>
              </Animated.View>

              <View style={styles.progressContainer}>
                <View style={styles.progressTrack}>
                  <Animated.View style={[styles.progressFill, { width: progressWidth }]} />
                </View>
                <Text style={styles.splashFooter}>Warananagar's own food app 🍽️</Text>
              </View>
            </Animated.View>
          )}

        </View>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

// ─────────────────────────────────────────────
//  STYLES
// ─────────────────────────────────────────────
const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#E24B4A',
  },
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
  webview: {
    flex: 1,
  },
  loadingBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    backgroundColor: 'rgba(226,75,74,0.15)',
    zIndex: 100,
  },
  loadingBarFill: {
    height: 3,
    width: '60%',
    backgroundColor: '#E24B4A',
  },
  splash: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#E24B4A',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },
  splashTopCircle: {
    position: 'absolute',
    top: -80,
    right: -80,
    width: 280,
    height: 280,
    borderRadius: 140,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  splashBottomCircle: {
    position: 'absolute',
    bottom: -100,
    left: -60,
    width: 320,
    height: 320,
    borderRadius: 160,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  splashLogoContainer: {
    alignItems: 'center',
    marginBottom: 60,
  },
  splashIconBox: {
    paddingHorizontal: 28,
    paddingVertical: 18,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 12,
  },
  splashWordLogo: {
    fontSize: 42,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: 2,
  },
  splashTitle: {
    fontSize: 32,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: 1,
    marginBottom: 8,
  },
  splashTagline: {
    fontSize: 15,
    color: 'rgba(255,255,255,0.85)',
    fontWeight: '400',
  },
  progressContainer: {
    position: 'absolute',
    bottom: 60,
    left: 40,
    right: 40,
    alignItems: 'center',
  },
  progressTrack: {
    width: '100%',
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.25)',
    borderRadius: 2,
    marginBottom: 20,
    overflow: 'hidden',
  },
  progressFill: {
    height: 4,
    backgroundColor: '#fff',
    borderRadius: 2,
  },
  splashFooter: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.65)',
  },
});