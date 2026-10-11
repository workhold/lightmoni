package agent

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	logcollector "go.opentelemetry.io/proto/otlp/collector/logs/v1"
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	logpb "go.opentelemetry.io/proto/otlp/logs/v1"
	resourcepb "go.opentelemetry.io/proto/otlp/resource/v1"
	"google.golang.org/protobuf/proto"
)

// Checkpoints and their frozen OTLP batches commit in one SQLite transaction.
// Re-opening or renaming a file does not replay data already in the spool.
type logCursor struct {
	ID         string
	Offset     int64
	Generation int64
	Prefix     []byte
	Path       string
}

type logCursorWriter interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func saveLogCursor(ctx context.Context, db logCursorWriter, c logCursor) error {
	_, err := db.ExecContext(ctx, `INSERT INTO log_cursors(id,offset,generation,prefix,path) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET offset=excluded.offset,generation=excluded.generation,prefix=excluded.prefix,path=excluded.path`, c.ID, c.Offset, c.Generation, c.Prefix, c.Path)
	return err
}

func logSourceID(s LogSource) string {
	return digest([]byte(fmt.Sprintf("%s\x00%s\x00%t", filepath.Clean(s.Directory), s.Pattern, s.Recursive)))
}

func fileLogID(info os.FileInfo, path string) string {
	// Linux distributions and macOS expose stable device/inode identities.
	value := reflect.Indirect(reflect.ValueOf(info.Sys()))
	if value.IsValid() && value.Kind() == reflect.Struct {
		dev, inode := value.FieldByName("Dev"), value.FieldByName("Ino")
		if dev.IsValid() && inode.IsValid() && dev.CanInterface() && inode.CanInterface() {
			return digest([]byte(fmt.Sprintf("%v:%v", dev.Interface(), inode.Interface())))
		}
	}
	return digest([]byte(filepath.Clean(path)))
}

type watchedLog struct {
	file   *os.File
	path   string
	source string
	idle   int
}

type fileLogReader struct {
	agent *Agent
	files map[string]*watchedLog
}

func newFileLogReader(a *Agent) *fileLogReader {
	return &fileLogReader{agent: a, files: map[string]*watchedLog{}}
}
func (r *fileLogReader) close() {
	for _, file := range r.files {
		file.file.Close()
	}
	r.files = map[string]*watchedLog{}
}

func (a *Agent) fileLogLoop(ctx context.Context) {
	if !a.waitForTasks(ctx) {
		return
	}
	reader := newFileLogReader(a)
	defer reader.close()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		tasks := a.taskConfig()
		if err := reader.poll(ctx, tasks); err != nil && ctx.Err() == nil {
			a.collectorStatus("file_logs", err.Error())
		} else if tasks.LogsEnabled != nil && !*tasks.LogsEnabled {
			a.collectorStatus("file_logs", "disabled")
		} else if ctx.Err() == nil {
			a.collectorStatus("file_logs", "ok")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (r *fileLogReader) poll(ctx context.Context, tasks RemoteConfig) error {
	tasks = NormalizeRemoteConfig(tasks)
	if !*tasks.LogsEnabled {
		r.close()
		return nil
	}
	active, seen := map[string]bool{}, map[string]bool{}
	var failures []error
	for _, source := range tasks.LogSources {
		active[logSourceID(source)] = true
	}
	for id, file := range r.files {
		if !active[file.source] {
			file.file.Close()
			delete(r.files, id)
		}
	}
	for _, source := range tasks.LogSources {
		sourceID := logSourceID(source)
		var initialized int
		if err := r.agent.queue.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM log_sources WHERE id=?`, sourceID).Scan(&initialized); err != nil {
			return err
		}
		entries := 0
		err := filepath.WalkDir(source.Directory, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if path == source.Directory && !entry.IsDir() {
				return fmt.Errorf("configured log path is not a directory")
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			entries++
			if entries > 10000 {
				return fmt.Errorf("directory scan exceeds 10000 entries")
			}
			if entry.IsDir() {
				if path != source.Directory && !source.Recursive {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return nil
			}
			match, _ := filepath.Match(source.Pattern, entry.Name())
			if !match || strings.HasSuffix(strings.ToLower(entry.Name()), ".gz") || strings.HasSuffix(strings.ToLower(entry.Name()), ".zip") {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			id := digest([]byte(r.agent.identity.HostID + "\x00" + fileLogID(info, path)))
			seen[id] = true
			if watched := r.files[id]; watched != nil {
				watched.path = path
				return nil
			}
			if len(r.files) >= 256 {
				return fmt.Errorf("file log collection exceeds 256 open files")
			}
			file, err := os.Open(path)
			if err != nil {
				return err
			}
			// Reject replacements between discovery and open, including symlinks.
			opened, err := file.Stat()
			current, statErr := os.Lstat(path)
			if err != nil || statErr != nil || !current.Mode().IsRegular() || !opened.Mode().IsRegular() || !os.SameFile(info, opened) || !os.SameFile(current, opened) {
				file.Close()
				return fmt.Errorf("log file changed during discovery")
			}
			var exists int
			err = r.agent.queue.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM log_cursors WHERE id=?`, id).Scan(&exists)
			if err == nil && exists == 0 {
				cursor := logCursor{ID: id, Path: path, Prefix: readLogPrefix(file, 64)}
				if initialized == 0 && !source.FromBeginning {
					cursor.Offset = opened.Size()
				}
				err = saveLogCursor(ctx, r.agent.queue.db, cursor)
			}
			if err != nil {
				file.Close()
				return err
			}
			r.files[id] = &watchedLog{file: file, path: path, source: sourceID}
			return nil
		})
		if err == nil {
			_, err = r.agent.queue.db.ExecContext(ctx, `INSERT OR IGNORE INTO log_sources(id) VALUES(?)`, sourceID)
		}
		if err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", source.Directory, err))
		}
	}
	// Keep renamed/deleted descriptors briefly to drain outstanding writes.
	// Bound each pass to 8 MiB so very busy files cannot starve control/shutdown.
	budget := int64(8 << 20)
	for id, file := range r.files {
		if budget <= 0 {
			break
		}
		consumed, err := r.read(ctx, id, file, tasks, min(budget, 1<<20))
		budget -= consumed
		if err != nil {
			failures = append(failures, fmt.Errorf("%s: %w", file.path, err))
			continue
		}
		if consumed == 0 {
			file.idle++
		} else {
			file.idle = 0
		}
		if !seen[id] && file.idle >= 3 {
			file.file.Close()
			delete(r.files, id)
		}
	}
	return errors.Join(failures...)
}

func readLogPrefix(file *os.File, size int) []byte {
	buffer := make([]byte, size)
	n, _ := file.ReadAt(buffer, 0)
	return buffer[:n]
}

func (r *fileLogReader) read(ctx context.Context, id string, file *watchedLog, tasks RemoteConfig, budget int64) (int64, error) {
	cursor := logCursor{ID: id, Path: file.path}
	if err := r.agent.queue.db.QueryRowContext(ctx, `SELECT offset,generation,prefix FROM log_cursors WHERE id=?`, id).Scan(&cursor.Offset, &cursor.Generation, &cursor.Prefix); err != nil {
		return 0, err
	}
	info, err := file.file.Stat()
	if err != nil {
		return 0, err
	}
	if info.Size() < cursor.Offset || !bytes.Equal(readLogPrefix(file.file, len(cursor.Prefix)), cursor.Prefix) {
		cursor.Offset = 0
		cursor.Generation++
	}
	cursor.Prefix = readLogPrefix(file.file, 64)
	if _, err = file.file.Seek(cursor.Offset, io.SeekStart); err != nil {
		return 0, err
	}
	// Reserve space for resource/record metadata under the configured batch cap.
	lineLimit := min(64<<10, int(r.agent.cfg.MaxBatchBytes/4))
	reader := bufio.NewReaderSize(io.LimitReader(file.file, budget), lineLimit)
	var records []*logpb.LogRecord
	recordBytes := 1024 // Resource, scope, identity and protobuf framing headroom.
	start := cursor.Offset
	for len(records) < 256 {
		line, readErr := reader.ReadSlice('\n')
		fragment := errors.Is(readErr, bufio.ErrBufferFull)
		if readErr != nil && !fragment {
			if readErr != io.EOF {
				return 0, readErr
			}
			break // Incomplete lines remain at the checkpoint until terminated.
		}
		consumed := len(line)
		body := line
		if fragment {
			// Avoid cutting a valid UTF-8 character at a fragment boundary.
			for n := 0; n < 3 && len(body) > 0 && !utf8.Valid(body); n++ {
				body = body[:len(body)-1]
			}
			if utf8.Valid(body) {
				consumed = len(body)
			} else {
				body = line
			}
		} else {
			body = bytes.TrimSuffix(bytes.TrimSuffix(body, []byte{'\n'}), []byte{'\r'})
		}
		attributes := []*commonpb.KeyValue{
			logString("file_path", file.path), logString("file_name", filepath.Base(file.path)),
			logString("event_time_source", "observed"),
			logString("lightmoni.source_id", fmt.Sprintf("%s:%d", id, cursor.Generation)),
			{Key: "lightmoni.source_seq", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_IntValue{IntValue: cursor.Offset}}},
		}
		if fragment {
			attributes = append(attributes, &commonpb.KeyValue{Key: "log_fragment", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_BoolValue{BoolValue: true}}})
		}
		now := uint64(time.Now().UnixNano())
		record := &logpb.LogRecord{ObservedTimeUnixNano: now, Body: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: strings.ToValidUTF8(string(body), "�")}}, Attributes: attributes}
		if len(records) > 0 && int64(recordBytes+proto.Size(record)+8) > r.agent.cfg.MaxBatchBytes {
			break
		}
		records = append(records, record)
		recordBytes += proto.Size(record) + 8
		cursor.Offset += int64(consumed)
		if cursor.Offset-start >= r.agent.cfg.MaxBatchBytes/2 || fragment {
			break
		}
	}
	if len(records) == 0 {
		// Persist truncate detection and the fingerprint even with no complete line.
		return 0, saveLogCursor(ctx, r.agent.queue.db, cursor)
	}
	request := &logcollector.ExportLogsServiceRequest{ResourceLogs: []*logpb.ResourceLogs{{Resource: &resourcepb.Resource{Attributes: []*commonpb.KeyValue{logString("service.name", "lightmoni-agent"), logString("lightmoni.group_id", tasks.GroupID)}}, ScopeLogs: []*logpb.ScopeLogs{{Scope: &commonpb.InstrumentationScope{Name: "lightmoni.file-logs"}, LogRecords: records}}}}}
	payload, err := proto.Marshal(request)
	if err != nil {
		return 0, err
	}
	err = r.agent.accept(ctx, Batch{ID: uuid.NewString(), Signal: "logs", Table: tasks.LogTable, Service: "lightmoni-agent", CreatedAt: time.Now().UTC(), Payload: payload, ContentType: "application/x-protobuf"}, true, &cursor)
	if err != nil {
		return 0, err
	}
	return cursor.Offset - start, nil
}

func logString(key, value string) *commonpb.KeyValue {
	return &commonpb.KeyValue{Key: key, Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_StringValue{StringValue: value}}}
}
