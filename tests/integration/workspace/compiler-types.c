typedef   signed char       int8;
typedef unsigned char      uint8;
typedef   signed short      int16;
typedef unsigned short     uint16;
typedef   signed int        int32;
typedef unsigned int       uint32;
typedef   signed long long  int64;
typedef unsigned long long uint64;
typedef struct { char *data; int64 len; int64 size; } FBSTRING;
typedef int8 boolean;
struct $12WRAPPEDVALUE {
	int32 VALUE;
};
#define __FB_STATIC_ASSERT( expr ) extern int __$fb_structsizecheck[(expr) ? 1 : -1]
__FB_STATIC_ASSERT( sizeof( struct $12WRAPPEDVALUE ) == 4 );
struct $6PACKET {
	int32 AMOUNT;
};
__FB_STATIC_ASSERT( sizeof( struct $6PACKET ) == 4 );
struct $16__FB_ARRAYDIMTB$ {
	int64 ELEMENTS;
	int64 LBOUND;
	int64 UBOUND;
};
__FB_STATIC_ASSERT( sizeof( struct $16__FB_ARRAYDIMTB$ ) == 24 );
struct $8FBARRAY1I6PACKETE {
	struct $6PACKET* DATA;
	struct $6PACKET* PTR;
	int64 SIZE;
	int64 ELEMENT_LEN;
	int64 DIMENSIONS;
	int64 FLAGS;
	struct $16__FB_ARRAYDIMTB$ DIMTB[1];
};
__FB_STATIC_ASSERT( sizeof( struct $8FBARRAY1I6PACKETE ) == 72 );
struct $7FBARRAYI6PACKETE {
	struct $6PACKET* DATA;
	struct $6PACKET* PTR;
	int64 SIZE;
	int64 ELEMENT_LEN;
	int64 DIMENSIONS;
	int64 FLAGS;
	struct $16__FB_ARRAYDIMTB$ DIMTB[8];
};
__FB_STATIC_ASSERT( sizeof( struct $7FBARRAYI6PACKETE ) == 240 );
struct $7FBARRAYIvE {
	void* DATA;
	void* PTR;
	int64 SIZE;
	int64 ELEMENT_LEN;
	int64 DIMENSIONS;
	int64 FLAGS;
	struct $16__FB_ARRAYDIMTB$ DIMTB[8];
};
__FB_STATIC_ASSERT( sizeof( struct $7FBARRAYIvE ) == 240 );
int32 fb_ArrayRedimEx( struct $7FBARRAYIvE*, const uint64, const int32, const int32, const uint64, ... );
int32 fb_ArrayErase( struct $7FBARRAYIvE* );
void* calloc( unsigned long, unsigned long );
void fb_PrintInt( const int32, const int32, const int32 );
void fb_PrintLongint( const int32, const int64, const int32 );
void fb_PrintULongint( const int32, const uint64, const int32 );
void fb_PrintDouble( const int32, const double, const int32 );
void fb_PrintString( const int32, const FBSTRING*, const int32 );
FBSTRING* fb_StrInit( void*, const int64, const void*, const int64, const int32 );
void fb_StrDelete( const FBSTRING* );
FBSTRING* fb_StrAllocTempDescZEx( const char*, const int64 );
int32 fb_CVL( const FBSTRING* );
void* fb_ThreadCall( void*, const int32, const int64, const int32, ... );
static void fb_ctor__compilerztypes( void ) __attribute__(( constructor ));
void _ZN12WRAPPEDVALUEC1Ei( struct $12WRAPPEDVALUE*, int32 );
void THREADWORKER( void* );
struct $6PACKET _ZplR6PACKETS0_( struct $6PACKET*, struct $6PACKET* );

void _ZN12WRAPPEDVALUEC1Ei( struct $12WRAPPEDVALUE* THIS$1, int32 SOURCE$1 )
{
	_unusedlabel: ; void *_llvmbug18658 = &&_unusedlabel;
	label$2:;
	__builtin_memset( (int32*)THIS$1, 0, 4ll );
	*(int32*)THIS$1 = SOURCE$1;
	label$3:;
}

void THREADWORKER( void* VALUE$1 )
{
	_unusedlabel: ; void *_llvmbug18658 = &&_unusedlabel;
	label$4:;
	label$5:;
}

struct $6PACKET _ZplR6PACKETS0_( struct $6PACKET* FIRST$1, struct $6PACKET* SECOND$1 )
{
	_unusedlabel: ; void *_llvmbug18658 = &&_unusedlabel;
	struct $6PACKET fb$result$1;
	__builtin_memset( &fb$result$1, 0, 4ll );
	label$6:;
	struct $6PACKET RESULT$1;
	__builtin_memset( &RESULT$1, 0, 4ll );
	__builtin_memcpy( &fb$result$1, &RESULT$1, 4 );
	goto label$7;
	label$7:;
	return fb$result$1;
}

__attribute__(( constructor )) static void fb_ctor__compilerztypes( void )
{
	_unusedlabel: ; void *_llvmbug18658 = &&_unusedlabel;
	struct $6PACKET TMP$4$0;
	struct $12WRAPPEDVALUE TMP$5$0;
	struct $12WRAPPEDVALUE TMP$6$0;
	struct $12WRAPPEDVALUE* TMP$7$0;
	double TMP$9$0;
	void* TMP$13$0;
	label$0:;
	struct $6PACKET PACKETS$0[1];
	__builtin_memset( (struct $6PACKET*)PACKETS$0, 0, 4ll );
	struct $8FBARRAY1I6PACKETE tmp$2$0;
	*(struct $6PACKET**)&tmp$2$0 = (struct $6PACKET*)PACKETS$0;
	*(struct $6PACKET**)((uint8*)&tmp$2$0 + 8ll) = (struct $6PACKET*)PACKETS$0;
	*(int64*)((uint8*)&tmp$2$0 + 16ll) = 4ll;
	*(int64*)((uint8*)&tmp$2$0 + 24ll) = 4ll;
	*(int64*)((uint8*)&tmp$2$0 + 32ll) = 1ll;
	*(int64*)((uint8*)&tmp$2$0 + 40ll) = 49ll;
	*(int64*)((uint8*)&tmp$2$0 + 48ll) = 1ll;
	*(int64*)((uint8*)&tmp$2$0 + 56ll) = 0ll;
	*(int64*)((uint8*)&tmp$2$0 + 64ll) = 0ll;
	struct $7FBARRAYI6PACKETE DYNAMICPACKETS$0;
	*(struct $6PACKET**)&DYNAMICPACKETS$0 = (struct $6PACKET*)0ull;
	*(struct $6PACKET**)((uint8*)&DYNAMICPACKETS$0 + 8ll) = (struct $6PACKET*)0ull;
	*(int64*)((uint8*)&DYNAMICPACKETS$0 + 16ll) = 0ll;
	*(int64*)((uint8*)&DYNAMICPACKETS$0 + 24ll) = 4ll;
	*(int64*)((uint8*)&DYNAMICPACKETS$0 + 32ll) = 0ll;
	*(int64*)((uint8*)&DYNAMICPACKETS$0 + 40ll) = 8ll;
	__builtin_memset( (void*)((uint8*)&DYNAMICPACKETS$0 + 48ll), 0, 192ll );
	struct $6PACKET* PACKETPTR$0;
	PACKETPTR$0 = (struct $6PACKET*)PACKETS$0;
	double INFERRED$0;
	INFERRED$0 = 0x1.p+0;
	FBSTRING ENCODED$0;
	fb_StrInit( (void*)&ENCODED$0, -1ll, (void*)"\x5C" "0\x5C" "0\x5C" "0\x5C" "0", 9ll, 0 );
	struct $12WRAPPEDVALUE WRAPPED$0;
	_ZN12WRAPPEDVALUEC1Ei( &WRAPPED$0, 3 );
	struct $6PACKET vr$9 = _ZplR6PACKETS0_( (struct $6PACKET*)PACKETS$0, (struct $6PACKET*)PACKETS$0 );
	TMP$4$0 = vr$9;
	fb_PrintInt( 0, *(int32*)&TMP$4$0, 1 );
	fb_ArrayRedimEx( (struct $7FBARRAYIvE*)&DYNAMICPACKETS$0, 4ull, -1, 0, 1ull, 0ll, 0ll );
	fb_PrintInt( 0, *(int32*)*(int64*)&DYNAMICPACKETS$0, 1 );
	fb_PrintInt( 0, *(int32*)PACKETPTR$0, 1 );
	fb_PrintDouble( 0, 0x1.8p+2, 1 );
	fb_PrintDouble( 0, INFERRED$0 * 0x1.p+1, 1 );
	fb_PrintDouble( 0, __builtin_sin( INFERRED$0 ), 1 );
	int32 vr$15 = fb_CVL( (FBSTRING*)&ENCODED$0 );
	fb_PrintInt( 0, vr$15, 1 );
	fb_PrintInt( 0, *(int32*)&WRAPPED$0, 1 );
	_ZN12WRAPPEDVALUEC1Ei( &TMP$5$0, 5 );
	fb_PrintInt( 0, *(int32*)&TMP$5$0, 1 );
	_ZN12WRAPPEDVALUEC1Ei( &TMP$6$0, 5 );
	fb_PrintInt( 0, *(int32*)&TMP$6$0, 1 );
	struct $12WRAPPEDVALUE* ALLOCATED$0;
	void* vr$20 = calloc( 4ull, 1ull );
	TMP$7$0 = (struct $12WRAPPEDVALUE*)vr$20;
	if( TMP$7$0 == (struct $12WRAPPEDVALUE*)0ull) goto label$8;
	_ZN12WRAPPEDVALUEC1Ei( TMP$7$0, 5 );
	label$8:;
	ALLOCATED$0 = TMP$7$0;
	fb_PrintInt( 0, *(int32*)ALLOCATED$0, 1 );
	if( !(INFERRED$0 > 0x0p+0)) goto label$9;
	TMP$9$0 = 0x1.p+0;
	goto label$10;
	label$9:;
	TMP$9$0 = 0x1.p+1;
	label$10:;
	fb_PrintDouble( 0, TMP$9$0, 1 );
	fb_PrintLongint( 0, -2ll, 1 );
	FBSTRING* vr$22 = fb_StrAllocTempDescZEx( (char*)"ab", 2ll );
	fb_PrintString( 0, (FBSTRING*)vr$22, 1 );
	TMP$13$0 = (void*)0ull;
	void* vr$24 = fb_ThreadCall( (void*)&THREADWORKER, 1, 0ll, 1, 13ll, &TMP$13$0 );
	fb_PrintULongint( 0, (uint64)vr$24, 1 );
	fb_StrDelete( (FBSTRING*)&ENCODED$0 );
	fb_ArrayErase( (struct $7FBARRAYIvE*)&DYNAMICPACKETS$0 );
	label$1:;
}

static const char __attribute__((used, section(".fbctinf"))) __fbctinf[] = "-l\0ffi\0-mt";
