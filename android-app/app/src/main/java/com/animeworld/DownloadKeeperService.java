package com.animeworld;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

// Keeps the app process (and therefore the WebView's background downloads) alive while
// episodes are downloading. Runs as a foreground service with a persistent notification
// and a partial wake-lock so downloads continue even when the app is minimised.
public class DownloadKeeperService extends Service {
    private static final int NOTIF_ID = 1;
    private static final String CHANNEL = "animeworld_downloads";
    private PowerManager.WakeLock wakeLock;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIF_ID, buildNotification());
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AnimeWorld:downloads");
            wakeLock.acquire(6L * 60 * 60 * 1000); // capped at 6h; released on destroy
        }
        return START_NOT_STICKY;
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW);
            ch.setShowBadge(false);
            getSystemService(NotificationManager.class).createNotificationChannel(ch);
            b = new Notification.Builder(this, CHANNEL);
        } else {
            b = new Notification.Builder(this);
        }
        b.setContentTitle("AnimeWorld")
         .setContentText("Downloading episodes in the background…")
         .setSmallIcon(android.R.drawable.ic_menu_gallery)
         .setContentIntent(pi)
         .setOngoing(true);
        return (Build.VERSION.SDK_INT >= Build.VERSION_CODES.JELLY_BEAN) ? b.build() : b.getNotification();
    }

    @Override
    public void onDestroy() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
